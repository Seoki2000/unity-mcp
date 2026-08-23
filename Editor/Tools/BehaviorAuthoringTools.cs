using System;
using System.Collections.Generic;
using System.Reflection;
using UnityEditor;
using UnityEngine;

namespace Community.Unity.MCP
{
    // BehaviorTools 와 나누어 두는 이유: 저쪽은 런타임 그래프의 노드를 편집하고,
    // 이쪽은 저작(authoring) 에셋을 SerializedProperty 로 읽고 쓴다. Unity.Behavior 타입은
    // 어셈블리 참조 없이 이름 문자열로만 다루므로 패키지가 그 패키지에 의존하지 않는다.
    [McpToolProvider]
    public static class BehaviorAuthoringTools
    {
        private const string AuthoringGraphTypeName = "Unity.Behavior.BehaviorAuthoringGraph";
        private const string AuthoringBlackboardTypeName = "Unity.Behavior.BehaviorBlackboardAuthoringAsset";
        private const string RuntimeGraphTypeName = "Unity.Behavior.BehaviorGraph";
        private const string RuntimeBlackboardTypeName = "Unity.Behavior.RuntimeBlackboardAsset";

        [McpTool("unity_behavior_list_graphs", "List Unity Behavior graph and blackboard assets", typeof(ListBehaviorGraphsArgs))]
        public static object ListBehaviorGraphs(string argsJson)
        {
            var args = JsonUtility.FromJson<ListBehaviorGraphsArgs>(argsJson) ?? new ListBehaviorGraphsArgs();
            string folder = string.IsNullOrEmpty(args.folder) ? "Assets" : args.folder;
            int maxResults = args.maxResults > 0 ? args.maxResults : 100;

            var results = new List<BehaviorAssetInfo>();
            string[] guids = AssetDatabase.FindAssets("t:ScriptableObject", new[] { folder });
            var seen = new HashSet<string>();

            foreach (string guid in guids)
            {
                string path = AssetDatabase.GUIDToAssetPath(guid);
                if (string.IsNullOrEmpty(path))
                {
                    continue;
                }

                foreach (UnityEngine.Object asset in AssetDatabase.LoadAllAssetsAtPath(path))
                {
                    if (asset == null)
                    {
                        continue;
                    }

                    string typeName = asset.GetType().FullName;
                    if (!IsBehaviorAssetType(typeName))
                    {
                        continue;
                    }

                    if (!args.includeRuntimeAssets && (typeName == RuntimeGraphTypeName || typeName == RuntimeBlackboardTypeName))
                    {
                        continue;
                    }

                    string key = path + "|" + asset.name + "|" + typeName;
                    if (!seen.Add(key))
                    {
                        continue;
                    }

                    results.Add(BuildAssetInfo(path, asset, typeName));
                    if (results.Count >= maxResults)
                    {
                        return new ListBehaviorGraphsResult { count = results.Count, assets = results.ToArray() };
                    }
                }
            }

            return new ListBehaviorGraphsResult { count = results.Count, assets = results.ToArray() };
        }

        [McpTool("unity_behavior_get_graph", "Read a Unity Behavior authoring graph asset", typeof(GetBehaviorGraphArgs))]
        public static object GetBehaviorGraph(string argsJson)
        {
            var args = JsonUtility.FromJson<GetBehaviorGraphArgs>(argsJson);
            if (args == null || string.IsNullOrEmpty(args.assetPath))
            {
                return Error("assetPath parameter is required");
            }

            UnityEngine.Object graph = FindAssetAtPath(args.assetPath, AuthoringGraphTypeName, args.objectName);
            if (graph == null)
            {
                return Error("Behavior authoring graph not found: " + args.assetPath);
            }

            return BuildGraphInfo(args.assetPath, graph, args);
        }

        [McpTool("unity_behavior_open_graph", "Open a Unity Behavior graph in the Behavior window", typeof(OpenBehaviorGraphArgs))]
        public static object OpenBehaviorGraph(string argsJson)
        {
            var args = JsonUtility.FromJson<OpenBehaviorGraphArgs>(argsJson);
            if (args == null || string.IsNullOrEmpty(args.assetPath))
            {
                return Error("assetPath parameter is required");
            }

            UnityEngine.Object graph = FindAssetAtPath(args.assetPath, AuthoringGraphTypeName, args.objectName);
            if (graph == null)
            {
                return Error("Behavior authoring graph not found: " + args.assetPath);
            }

            Selection.activeObject = graph;
            bool opened = AssetDatabase.OpenAsset(graph);

            return new OpenBehaviorGraphResult
            {
                success = opened,
                assetPath = args.assetPath,
                objectName = graph.name
            };
        }

        [McpTool("unity_behavior_set_graph_description", "Set a Unity Behavior graph description", typeof(SetBehaviorGraphDescriptionArgs))]
        public static object SetBehaviorGraphDescription(string argsJson)
        {
            var args = JsonUtility.FromJson<SetBehaviorGraphDescriptionArgs>(argsJson);
            if (args == null || string.IsNullOrEmpty(args.assetPath))
            {
                return Error("assetPath parameter is required");
            }

            UnityEngine.Object graph = FindAssetAtPath(args.assetPath, AuthoringGraphTypeName, args.objectName);
            if (graph == null)
            {
                return Error("Behavior authoring graph not found: " + args.assetPath);
            }

            Undo.RecordObject(graph, "Set Behavior Graph Description");
            var serializedGraph = new SerializedObject(graph);
            SerializedProperty description = serializedGraph.FindProperty("m_Description");
            if (description == null)
            {
                return Error("m_Description property not found on graph: " + args.assetPath);
            }

            description.stringValue = args.description ?? string.Empty;
            serializedGraph.ApplyModifiedProperties();
            MarkDirtyAndSave(graph);

            return new SetBehaviorGraphDescriptionResult
            {
                success = true,
                assetPath = args.assetPath,
                objectName = graph.name,
                description = args.description ?? string.Empty
            };
        }

        [McpTool("unity_behavior_set_node_position", "Move a node in a Unity Behavior graph by managedReferenceId or serialized node ID", typeof(SetBehaviorNodePositionArgs))]
        public static object SetBehaviorNodePosition(string argsJson)
        {
            var args = JsonUtility.FromJson<SetBehaviorNodePositionArgs>(argsJson);
            if (args == null || string.IsNullOrEmpty(args.assetPath))
            {
                return Error("assetPath parameter is required");
            }
            if (string.IsNullOrEmpty(args.nodeId))
            {
                return Error("nodeId parameter is required");
            }

            UnityEngine.Object graph = FindAssetAtPath(args.assetPath, AuthoringGraphTypeName, args.objectName);
            if (graph == null)
            {
                return Error("Behavior authoring graph not found: " + args.assetPath);
            }

            Undo.RecordObject(graph, "Move Behavior Graph Node");
            var serializedGraph = new SerializedObject(graph);
            SerializedProperty nodes = serializedGraph.FindProperty("m_Nodes");
            if (nodes == null || !nodes.isArray)
            {
                return Error("m_Nodes array not found on graph: " + args.assetPath);
            }

            for (int i = 0; i < nodes.arraySize; i++)
            {
                SerializedProperty node = nodes.GetArrayElementAtIndex(i);
                if (!NodeMatches(node, args.nodeId))
                {
                    continue;
                }

                SerializedProperty position = node.FindPropertyRelative("Position");
                if (position == null)
                {
                    return Error("Position property not found on node: " + args.nodeId);
                }

                position.vector2Value = new Vector2(args.x, args.y);
                serializedGraph.ApplyModifiedProperties();
                MarkDirtyAndSave(graph);

                return new SetBehaviorNodePositionResult
                {
                    success = true,
                    assetPath = args.assetPath,
                    objectName = graph.name,
                    nodeId = args.nodeId,
                    x = args.x,
                    y = args.y
                };
            }

            return Error("Node not found: " + args.nodeId);
        }

        [McpTool("unity_behavior_set_blackboard_variable_value", "Set an existing Unity Behavior blackboard variable value", typeof(SetBehaviorBlackboardVariableValueArgs))]
        public static object SetBehaviorBlackboardVariableValue(string argsJson)
        {
            var args = JsonUtility.FromJson<SetBehaviorBlackboardVariableValueArgs>(argsJson);
            if (args == null || string.IsNullOrEmpty(args.assetPath))
            {
                return Error("assetPath parameter is required");
            }
            if (string.IsNullOrEmpty(args.variableName))
            {
                return Error("variableName parameter is required");
            }

            UnityEngine.Object blackboard = FindBlackboardForAsset(args.assetPath, args.objectName);
            if (blackboard == null)
            {
                return Error("Behavior blackboard not found for asset: " + args.assetPath);
            }

            Undo.RecordObject(blackboard, "Set Behavior Blackboard Variable");
            var serializedBlackboard = new SerializedObject(blackboard);
            SerializedProperty variables = FindVariablesProperty(serializedBlackboard);
            if (variables == null || !variables.isArray)
            {
                return Error("Blackboard variable list not found: " + args.assetPath);
            }

            for (int i = 0; i < variables.arraySize; i++)
            {
                SerializedProperty variable = variables.GetArrayElementAtIndex(i);
                SerializedProperty name = variable.FindPropertyRelative("Name");
                if (name == null || name.stringValue != args.variableName)
                {
                    continue;
                }

                SerializedProperty value = variable.FindPropertyRelative("m_Value");
                if (value == null)
                {
                    return Error("Variable has no writable m_Value property: " + args.variableName);
                }

                string before = PropertyToString(value);
                if (!TrySetSerializedValue(value, args.value, args.valueType, out string error))
                {
                    return Error(error);
                }

                serializedBlackboard.ApplyModifiedProperties();
                MarkDirtyAndSave(blackboard);

                return new SetBehaviorBlackboardVariableValueResult
                {
                    success = true,
                    assetPath = args.assetPath,
                    objectName = blackboard.name,
                    variableName = args.variableName,
                    before = before,
                    after = PropertyToString(value)
                };
            }

            return Error("Blackboard variable not found: " + args.variableName);
        }

        private static BehaviorAssetInfo BuildAssetInfo(string path, UnityEngine.Object asset, string typeName)
        {
            var info = new BehaviorAssetInfo
            {
                path = path,
                name = asset.name,
                type = typeName,
                isAuthoringGraph = typeName == AuthoringGraphTypeName,
                isRuntimeGraph = typeName == RuntimeGraphTypeName,
                isBlackboard = typeName == AuthoringBlackboardTypeName || typeName == RuntimeBlackboardTypeName
            };

            var serialized = new SerializedObject(asset);
            SerializedProperty nodes = serialized.FindProperty("m_Nodes");
            if (nodes != null && nodes.isArray)
            {
                info.nodeCount = nodes.arraySize;
            }

            SerializedProperty variables = FindVariablesProperty(serialized);
            if (variables != null && variables.isArray)
            {
                info.blackboardVariableCount = variables.arraySize;
            }

            return info;
        }

        private static BehaviorGraphInfo BuildGraphInfo(string path, UnityEngine.Object graph, GetBehaviorGraphArgs args)
        {
            var serializedGraph = new SerializedObject(graph);
            SerializedProperty nodes = serializedGraph.FindProperty("m_Nodes");
            SerializedProperty description = serializedGraph.FindProperty("m_Description");
            SerializedProperty versionTimestamp = serializedGraph.FindProperty("m_VersionTimestamp");
            SerializedProperty blackboardReference = serializedGraph.FindProperty("Blackboard");

            int maxNodes = args.maxNodes > 0 ? args.maxNodes : 200;
            var nodeInfos = new List<BehaviorNodeInfo>();
            var edgeInfos = new List<BehaviorEdgeInfo>();
            var nodeModelInfos = ReadNodeModelInfos(serializedGraph);
            var nodeTypeNamesById = new Dictionary<string, string>();
            foreach (BehaviorNodeModelInfo info in nodeModelInfos)
            {
                if (!string.IsNullOrEmpty(info.runtimeTypeId) && !nodeTypeNamesById.ContainsKey(info.runtimeTypeId))
                {
                    nodeTypeNamesById.Add(info.runtimeTypeId, info.name);
                }
            }

            if (nodes != null && nodes.isArray)
            {
                int count = Mathf.Min(nodes.arraySize, maxNodes);
                for (int i = 0; i < count; i++)
                {
                    SerializedProperty node = nodes.GetArrayElementAtIndex(i);
                    BehaviorNodeInfo nodeInfo = ReadNodeInfo(node, nodeTypeNamesById, args.includeFields);
                    nodeInfos.Add(nodeInfo);
                    if (args.includeEdges)
                    {
                        ReadEdges(node, nodeInfo.managedReferenceId, edgeInfos);
                    }
                }
            }

            UnityEngine.Object blackboard = blackboardReference?.objectReferenceValue;
            BehaviorBlackboardVariableInfo[] variables = Array.Empty<BehaviorBlackboardVariableInfo>();
            if (args.includeBlackboard && blackboard != null)
            {
                variables = ReadBlackboardVariables(blackboard);
            }

            return new BehaviorGraphInfo
            {
                assetPath = path,
                objectName = graph.name,
                description = description?.stringValue ?? string.Empty,
                versionTimestamp = versionTimestamp != null ? versionTimestamp.longValue : 0,
                blackboardName = blackboard != null ? blackboard.name : string.Empty,
                nodeCount = nodes != null && nodes.isArray ? nodes.arraySize : 0,
                returnedNodeCount = nodeInfos.Count,
                nodes = nodeInfos.ToArray(),
                edges = edgeInfos.ToArray(),
                blackboardVariables = variables,
                nodeModelInfos = nodeModelInfos
            };
        }

        private static BehaviorNodeInfo ReadNodeInfo(SerializedProperty node, Dictionary<string, string> nodeTypeNamesById, bool includeFields)
        {
            string serializedNodeId = FormatGuid(node.FindPropertyRelative("ID"));
            string nodeTypeId = FormatGuid(node.FindPropertyRelative("NodeTypeID"));
            string typeName = ShortTypeName(node.managedReferenceFullTypename);
            string displayName = nodeTypeNamesById.TryGetValue(nodeTypeId, out string modelName) ? modelName : typeName;
            SerializedProperty position = node.FindPropertyRelative("Position");

            string portName = ReadString(node.FindPropertyRelative("PortName"));
            if (!string.IsNullOrEmpty(portName))
            {
                displayName = "Port: " + portName;
            }

            return new BehaviorNodeInfo
            {
                managedReferenceId = node.managedReferenceId.ToString(),
                serializedNodeId = serializedNodeId,
                displayName = displayName,
                modelType = typeName,
                runtimeTypeId = nodeTypeId,
                runtimeType = ReadString(node.FindPropertyRelative("NodeType.m_SerializableType")),
                portName = portName,
                parentNodeId = FormatGuid(node.FindPropertyRelative("ParentNodeID")),
                x = position != null ? position.vector2Value.x : 0f,
                y = position != null ? position.vector2Value.y : 0f,
                fields = includeFields ? ReadNodeFields(node) : Array.Empty<BehaviorFieldInfo>()
            };
        }

        private static BehaviorFieldInfo[] ReadNodeFields(SerializedProperty node)
        {
            SerializedProperty fields = node.FindPropertyRelative("m_FieldValues");
            if (fields == null || !fields.isArray)
            {
                return Array.Empty<BehaviorFieldInfo>();
            }

            var result = new List<BehaviorFieldInfo>();
            for (int i = 0; i < fields.arraySize; i++)
            {
                SerializedProperty field = fields.GetArrayElementAtIndex(i);
                SerializedProperty linkedVariable = field.FindPropertyRelative("LinkedVariable");
                SerializedProperty localValue = field.FindPropertyRelative("LocalValue");

                result.Add(new BehaviorFieldInfo
                {
                    fieldName = ReadString(field.FindPropertyRelative("FieldName")),
                    type = ReadString(field.FindPropertyRelative("Type.m_SerializableType")),
                    linkedVariableName = ReadString(linkedVariable?.FindPropertyRelative("Name")),
                    linkedVariableId = FormatGuid(linkedVariable?.FindPropertyRelative("ID")),
                    localValue = ReadManagedValue(localValue)
                });
            }

            return result.ToArray();
        }

        private static void ReadEdges(SerializedProperty node, string fromNodeId, List<BehaviorEdgeInfo> edges)
        {
            SerializedProperty ports = node.FindPropertyRelative("PortModels");
            if (ports == null || !ports.isArray)
            {
                return;
            }

            for (int i = 0; i < ports.arraySize; i++)
            {
                SerializedProperty port = ports.GetArrayElementAtIndex(i);
                string portDirection = ReadEnumLike(port.FindPropertyRelative("m_PortDataFlowType"));
                if (portDirection != "Output")
                {
                    continue;
                }

                string portName = ReadString(port.FindPropertyRelative("m_Name"));
                SerializedProperty connections = port.FindPropertyRelative("m_Connections");
                if (connections == null || !connections.isArray)
                {
                    continue;
                }

                for (int j = 0; j < connections.arraySize; j++)
                {
                    SerializedProperty connection = connections.GetArrayElementAtIndex(j);
                    SerializedProperty targetNode = connection.FindPropertyRelative("m_NodeModel");
                    edges.Add(new BehaviorEdgeInfo
                    {
                        fromNodeId = fromNodeId,
                        fromPort = portName,
                        toNodeId = targetNode != null ? targetNode.managedReferenceId.ToString() : string.Empty,
                        toPort = ReadString(connection.FindPropertyRelative("m_Name"))
                    });
                }
            }
        }

        private static BehaviorNodeModelInfo[] ReadNodeModelInfos(SerializedObject serializedGraph)
        {
            SerializedProperty modelInfos = serializedGraph.FindProperty("m_NodeModelsInfo");
            if (modelInfos == null || !modelInfos.isArray)
            {
                return Array.Empty<BehaviorNodeModelInfo>();
            }

            var result = new List<BehaviorNodeModelInfo>();
            for (int i = 0; i < modelInfos.arraySize; i++)
            {
                SerializedProperty info = modelInfos.GetArrayElementAtIndex(i);
                result.Add(new BehaviorNodeModelInfo
                {
                    name = ReadString(info.FindPropertyRelative("Name")),
                    story = ReadString(info.FindPropertyRelative("Story")),
                    runtimeType = ReadString(info.FindPropertyRelative("RuntimeTypeString")),
                    runtimeTypeId = FormatGuid(info.FindPropertyRelative("RuntimeTypeID")),
                    isPlaceholder = ReadBool(info.FindPropertyRelative("IsPlaceholder"))
                });
            }

            return result.ToArray();
        }

        private static BehaviorBlackboardVariableInfo[] ReadBlackboardVariables(UnityEngine.Object blackboard)
        {
            var serializedBlackboard = new SerializedObject(blackboard);
            SerializedProperty variables = FindVariablesProperty(serializedBlackboard);
            if (variables == null || !variables.isArray)
            {
                return Array.Empty<BehaviorBlackboardVariableInfo>();
            }

            var result = new List<BehaviorBlackboardVariableInfo>();
            for (int i = 0; i < variables.arraySize; i++)
            {
                SerializedProperty variable = variables.GetArrayElementAtIndex(i);
                result.Add(new BehaviorBlackboardVariableInfo
                {
                    managedReferenceId = variable.managedReferenceId.ToString(),
                    serializedVariableId = FormatGuid(variable.FindPropertyRelative("ID")),
                    name = ReadString(variable.FindPropertyRelative("Name")),
                    type = ShortTypeName(variable.managedReferenceFullTypename),
                    isExposed = ReadBool(variable.FindPropertyRelative("IsExposed")),
                    isShared = ReadBool(variable.FindPropertyRelative("m_IsShared")),
                    value = PropertyToString(variable.FindPropertyRelative("m_Value"))
                });
            }

            return result.ToArray();
        }

        private static SerializedProperty FindVariablesProperty(SerializedObject serializedObject)
        {
            return serializedObject.FindProperty("m_Variables")
                ?? serializedObject.FindProperty("m_Blackboard.m_Variables");
        }

        private static UnityEngine.Object FindBlackboardForAsset(string assetPath, string objectName)
        {
            UnityEngine.Object direct = FindAssetAtPath(assetPath, AuthoringBlackboardTypeName, objectName);
            if (direct != null)
            {
                return direct;
            }

            UnityEngine.Object graph = FindAssetAtPath(assetPath, AuthoringGraphTypeName, objectName);
            if (graph == null)
            {
                return null;
            }

            var serializedGraph = new SerializedObject(graph);
            return serializedGraph.FindProperty("Blackboard")?.objectReferenceValue;
        }

        private static UnityEngine.Object FindAssetAtPath(string path, string fullTypeName, string objectName)
        {
            foreach (UnityEngine.Object asset in AssetDatabase.LoadAllAssetsAtPath(path))
            {
                if (asset == null || asset.GetType().FullName != fullTypeName)
                {
                    continue;
                }
                if (!string.IsNullOrEmpty(objectName) && asset.name != objectName)
                {
                    continue;
                }
                return asset;
            }

            return null;
        }

        private static bool IsBehaviorAssetType(string typeName)
        {
            return typeName == AuthoringGraphTypeName
                || typeName == AuthoringBlackboardTypeName
                || typeName == RuntimeGraphTypeName
                || typeName == RuntimeBlackboardTypeName;
        }

        private static bool NodeMatches(SerializedProperty node, string nodeId)
        {
            if (node.managedReferenceId.ToString() == nodeId)
            {
                return true;
            }

            return FormatGuid(node.FindPropertyRelative("ID")) == nodeId;
        }

        private static bool TrySetSerializedValue(SerializedProperty property, string value, string valueType, out string error)
        {
            error = null;
            string type = string.IsNullOrEmpty(valueType) ? property.propertyType.ToString().ToLowerInvariant() : valueType.ToLowerInvariant();

            try
            {
                switch (type)
                {
                    case "boolean":
                    case "bool":
                        property.boolValue = bool.Parse(value);
                        return true;
                    case "integer":
                    case "int":
                        property.intValue = int.Parse(value);
                        return true;
                    case "long":
                        property.longValue = long.Parse(value);
                        return true;
                    case "float":
                    case "single":
                    case "double":
                        property.floatValue = float.Parse(value);
                        return true;
                    case "string":
                        property.stringValue = value ?? string.Empty;
                        return true;
                    case "enum":
                        if (int.TryParse(value, out int enumIndex))
                        {
                            property.enumValueIndex = enumIndex;
                        }
                        else
                        {
                            for (int i = 0; i < property.enumDisplayNames.Length; i++)
                            {
                                if (string.Equals(property.enumDisplayNames[i], value, StringComparison.OrdinalIgnoreCase))
                                {
                                    property.enumValueIndex = i;
                                    return true;
                                }
                            }
                            error = "Unknown enum value: " + value;
                            return false;
                        }
                        return true;
                    default:
                        error = "Unsupported value type '" + type + "' for property type " + property.propertyType;
                        return false;
                }
            }
            catch (Exception ex)
            {
                error = "Failed to parse value '" + value + "' as " + type + ": " + ex.Message;
                return false;
            }
        }

        private static void MarkDirtyAndSave(UnityEngine.Object asset)
        {
            InvokeSetAssetDirty(asset);
            EditorUtility.SetDirty(asset);
            AssetDatabase.SaveAssetIfDirty(asset);
            AssetDatabase.SaveAssets();
        }

        private static void InvokeSetAssetDirty(UnityEngine.Object asset)
        {
            MethodInfo method = asset.GetType().GetMethod("SetAssetDirty", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (method == null)
            {
                return;
            }

            ParameterInfo[] parameters = method.GetParameters();
            if (parameters.Length == 0)
            {
                method.Invoke(asset, null);
            }
            else if (parameters.Length == 1 && parameters[0].ParameterType == typeof(bool))
            {
                method.Invoke(asset, new object[] { true });
            }
        }

        private static string FormatGuid(SerializedProperty guid)
        {
            if (guid == null)
            {
                return string.Empty;
            }

            SerializedProperty value0 = guid.FindPropertyRelative("m_Value0");
            SerializedProperty value1 = guid.FindPropertyRelative("m_Value1");
            if (value0 == null || value1 == null)
            {
                return string.Empty;
            }

            return value0.longValue + ":" + value1.longValue;
        }

        private static string ReadManagedValue(SerializedProperty managedReference)
        {
            if (managedReference == null)
            {
                return string.Empty;
            }

            SerializedProperty value = managedReference.FindPropertyRelative("m_Value");
            return value != null ? PropertyToString(value) : string.Empty;
        }

        private static string PropertyToString(SerializedProperty property)
        {
            if (property == null)
            {
                return string.Empty;
            }

            switch (property.propertyType)
            {
                case SerializedPropertyType.Boolean:
                    return property.boolValue.ToString();
                case SerializedPropertyType.Integer:
                    return property.longValue.ToString();
                case SerializedPropertyType.Float:
                    return property.floatValue.ToString();
                case SerializedPropertyType.String:
                    return property.stringValue;
                case SerializedPropertyType.Enum:
                    return property.enumDisplayNames.Length > property.enumValueIndex && property.enumValueIndex >= 0
                        ? property.enumDisplayNames[property.enumValueIndex]
                        : property.enumValueIndex.ToString();
                case SerializedPropertyType.ObjectReference:
                    return property.objectReferenceValue != null ? property.objectReferenceValue.name : "null";
                case SerializedPropertyType.Vector2:
                    return property.vector2Value.ToString();
                case SerializedPropertyType.Vector3:
                    return property.vector3Value.ToString();
                case SerializedPropertyType.Color:
                    return property.colorValue.ToString();
                default:
                    return property.propertyType.ToString();
            }
        }

        private static string ReadString(SerializedProperty property)
        {
            return property != null ? property.stringValue : string.Empty;
        }

        private static bool ReadBool(SerializedProperty property)
        {
            return property != null && property.boolValue;
        }

        private static string ReadEnumLike(SerializedProperty property)
        {
            if (property == null)
            {
                return string.Empty;
            }

            if (property.propertyType == SerializedPropertyType.Enum &&
                property.enumDisplayNames.Length > property.enumValueIndex &&
                property.enumValueIndex >= 0)
            {
                return property.enumDisplayNames[property.enumValueIndex];
            }

            return property.intValue == 0 ? "Input" : "Output";
        }

        private static string ShortTypeName(string managedReferenceFullTypename)
        {
            if (string.IsNullOrEmpty(managedReferenceFullTypename))
            {
                return string.Empty;
            }

            int space = managedReferenceFullTypename.LastIndexOf(' ');
            string type = space >= 0 ? managedReferenceFullTypename.Substring(space + 1) : managedReferenceFullTypename;
            int dot = type.LastIndexOf('.');
            return dot >= 0 ? type.Substring(dot + 1).Replace('+', '/') : type.Replace('+', '/');
        }

        private static object Error(string message)
        {
            return new ErrorResult { error = message };
        }

        [Serializable]
        public class ListBehaviorGraphsArgs
        {
            [McpParam("Folder to search, defaults to Assets")] public string folder;
            [McpParam("Include runtime BehaviorGraph and RuntimeBlackboardAsset subassets")] public bool includeRuntimeAssets;
            [McpParam("Maximum results, defaults to 100")] public int maxResults;
        }

        [Serializable]
        public class GetBehaviorGraphArgs
        {
            [McpParam("Path to a Behavior graph asset", Required = true)] public string assetPath;
            [McpParam("Optional subasset object name")] public string objectName;
            [McpParam("Include node field values")] public bool includeFields = true;
            [McpParam("Include edge data")] public bool includeEdges = true;
            [McpParam("Include graph blackboard variables")] public bool includeBlackboard = true;
            [McpParam("Maximum nodes to return, defaults to 200")] public int maxNodes;
        }

        [Serializable]
        public class OpenBehaviorGraphArgs
        {
            [McpParam("Path to a Behavior graph asset", Required = true)] public string assetPath;
            [McpParam("Optional subasset object name")] public string objectName;
        }

        [Serializable]
        public class SetBehaviorGraphDescriptionArgs
        {
            [McpParam("Path to a Behavior graph asset", Required = true)] public string assetPath;
            [McpParam("Optional subasset object name")] public string objectName;
            [McpParam("New graph description")] public string description;
        }

        [Serializable]
        public class SetBehaviorNodePositionArgs
        {
            [McpParam("Path to a Behavior graph asset", Required = true)] public string assetPath;
            [McpParam("Optional subasset object name")] public string objectName;
            [McpParam("Node managedReferenceId or serialized node ID", Required = true)] public string nodeId;
            [McpParam("New graph-space X position")] public float x;
            [McpParam("New graph-space Y position")] public float y;
        }

        [Serializable]
        public class SetBehaviorBlackboardVariableValueArgs
        {
            [McpParam("Path to a Behavior graph or blackboard asset", Required = true)] public string assetPath;
            [McpParam("Optional graph or blackboard subasset object name")] public string objectName;
            [McpParam("Existing blackboard variable name", Required = true)] public string variableName;
            [McpParam("New value as a string", Required = true)] public string value;
            [McpParam("Optional value type: bool, int, long, float, string, enum")] public string valueType;
        }

        [Serializable]
        public class ErrorResult
        {
            public string error;
        }

        [Serializable]
        public class ListBehaviorGraphsResult
        {
            public int count;
            public BehaviorAssetInfo[] assets;
        }

        [Serializable]
        public class BehaviorAssetInfo
        {
            public string path;
            public string name;
            public string type;
            public bool isAuthoringGraph;
            public bool isRuntimeGraph;
            public bool isBlackboard;
            public int nodeCount;
            public int blackboardVariableCount;
        }

        [Serializable]
        public class BehaviorGraphInfo
        {
            public string assetPath;
            public string objectName;
            public string description;
            public long versionTimestamp;
            public string blackboardName;
            public int nodeCount;
            public int returnedNodeCount;
            public BehaviorNodeInfo[] nodes;
            public BehaviorEdgeInfo[] edges;
            public BehaviorBlackboardVariableInfo[] blackboardVariables;
            public BehaviorNodeModelInfo[] nodeModelInfos;
        }

        [Serializable]
        public class BehaviorNodeInfo
        {
            public string managedReferenceId;
            public string serializedNodeId;
            public string displayName;
            public string modelType;
            public string runtimeTypeId;
            public string runtimeType;
            public string portName;
            public string parentNodeId;
            public float x;
            public float y;
            public BehaviorFieldInfo[] fields;
        }

        [Serializable]
        public class BehaviorFieldInfo
        {
            public string fieldName;
            public string type;
            public string linkedVariableName;
            public string linkedVariableId;
            public string localValue;
        }

        [Serializable]
        public class BehaviorEdgeInfo
        {
            public string fromNodeId;
            public string fromPort;
            public string toNodeId;
            public string toPort;
        }

        [Serializable]
        public class BehaviorBlackboardVariableInfo
        {
            public string managedReferenceId;
            public string serializedVariableId;
            public string name;
            public string type;
            public bool isExposed;
            public bool isShared;
            public string value;
        }

        [Serializable]
        public class BehaviorNodeModelInfo
        {
            public string name;
            public string story;
            public string runtimeType;
            public string runtimeTypeId;
            public bool isPlaceholder;
        }

        [Serializable]
        public class OpenBehaviorGraphResult
        {
            public bool success;
            public string assetPath;
            public string objectName;
        }

        [Serializable]
        public class SetBehaviorGraphDescriptionResult
        {
            public bool success;
            public string assetPath;
            public string objectName;
            public string description;
        }

        [Serializable]
        public class SetBehaviorNodePositionResult
        {
            public bool success;
            public string assetPath;
            public string objectName;
            public string nodeId;
            public float x;
            public float y;
        }

        [Serializable]
        public class SetBehaviorBlackboardVariableValueResult
        {
            public bool success;
            public string assetPath;
            public string objectName;
            public string variableName;
            public string before;
            public string after;
        }
    }
}
