using System;
using System.Collections.Generic;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace Community.Unity.MCP
{
    [McpToolProvider]
    public class BehaviorTools
    {
        [McpTool("unity_get_bt_graph", "Get details of a Behavior Graph (nodes, edges, blackboard)", typeof(GetGraphArgs), ReadOnly = true)]
        public static object GetBehaviorGraph(string argsJson)
        {
            var args = JsonUtility.FromJson<GetGraphArgs>(argsJson);
            if (string.IsNullOrEmpty(args?.path))
                return new McpToolError { error = "path parameter is required" };

            var graph = AssetDatabase.LoadAssetAtPath<ScriptableObject>(args.path);
            if (graph == null)
                return new McpToolError { error = $"Graph not found at {args.path}" };

            var so = new SerializedObject(graph);
            
            var nodesProp = so.FindProperty("m_Nodes");
            var nodes = new List<NodeInfo>();
            if (nodesProp != null && nodesProp.isArray)
            {
                for (int i = 0; i < nodesProp.arraySize; i++)
                {
                    nodes.Add(ParseNode(nodesProp.GetArrayElementAtIndex(i)));
                }
            }

            string blackboardName = "";
            var bbProp = so.FindProperty("Blackboard");
            if (bbProp != null && bbProp.objectReferenceValue != null)
                blackboardName = bbProp.objectReferenceValue.name;

            return new GraphResult
            {
                path = args.path,
                blackboardName = blackboardName,
                nodeCount = nodes.Count,
                nodes = nodes.ToArray()
            };
        }

        [McpTool("unity_add_bt_node", "Add a new node to a Behavior Graph", typeof(AddNodeArgs))]
        public static object AddBtNode(string argsJson)
        {
            var args = JsonUtility.FromJson<AddNodeArgs>(argsJson);
            var graph = AssetDatabase.LoadAssetAtPath<ScriptableObject>(args.path);
            if (graph == null) return new McpToolError { error = "Graph not found" };

            Type nodeType = GetTypeByName(args.nodeType);
            if (nodeType == null) return new McpToolError { error = $"Node type {args.nodeType} not found" };

            try
            {
                var createMethod = graph.GetType().GetMethod("CreateNode", BindingFlags.Public | BindingFlags.Instance | BindingFlags.FlattenHierarchy);
                if (createMethod == null) return new McpToolError { error = "CreateNode method not found on graph" };

                Vector2 pos = args.position != null ? new Vector2(args.position.x, args.position.y) : Vector2.zero;
                var newNode = createMethod.Invoke(graph, new object[] { nodeType, pos, null, null });
                
                var saveMethod = graph.GetType().GetMethod("SaveAsset", BindingFlags.Public | BindingFlags.Instance | BindingFlags.FlattenHierarchy);
                if (saveMethod != null) saveMethod.Invoke(graph, null);

                EditorUtility.SetDirty(graph);
                AssetDatabase.SaveAssets();

                return new { success = true, nodeType = nodeType.Name };
            }
            catch (Exception ex)
            {
                return new McpToolError { error = ex.ToString() };
            }
        }

        [McpTool("unity_remove_bt_node", "Remove a node from a Behavior Graph", typeof(RemoveNodeArgs), Destructive = true)]
        public static object RemoveBtNode(string argsJson)
        {
            var args = JsonUtility.FromJson<RemoveNodeArgs>(argsJson);
            var graph = AssetDatabase.LoadAssetAtPath<ScriptableObject>(args.path);
            if (graph == null) return new McpToolError { error = "Graph not found" };

            try
            {
                var nodesProp = graph.GetType().GetProperty("Nodes");
                var nodesList = nodesProp.GetValue(graph) as System.Collections.IList;
                if (nodesList == null) return new McpToolError { error = "Could not get Nodes list" };

                object nodeToDelete = null;
                foreach (var node in nodesList)
                {
                    var idField = node.GetType().GetField("ID");
                    var idVal = idField.GetValue(node);
                    // ID is SerializableGUID. We can use JSON to compare easily.
                    string idJson = JsonUtility.ToJson(idVal);
                    // Parse back or just compare if we know the values
                    // Actually, getting the 4 uints is safer:
                    var v0 = idVal.GetType().GetField("m_Value0", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(idVal) ?? 0;
                    var v1 = idVal.GetType().GetField("m_Value1", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(idVal) ?? 0;
                    var v2 = idVal.GetType().GetField("m_Value2", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(idVal) ?? 0;
                    var v3 = idVal.GetType().GetField("m_Value3", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(idVal) ?? 0;
                    string idStr = $"{v0}-{v1}-{v2}-{v3}";
                    
                    if (idStr == args.nodeId)
                    {
                        nodeToDelete = node;
                        break;
                    }
                }

                if (nodeToDelete == null) return new McpToolError { error = $"Node {args.nodeId} not found" };

                var deleteMethod = graph.GetType().GetMethod("DeleteNode", BindingFlags.Public | BindingFlags.Instance | BindingFlags.FlattenHierarchy);
                if (deleteMethod != null)
                {
                    deleteMethod.Invoke(graph, new object[] { nodeToDelete });
                }
                else
                {
                    nodesList.Remove(nodeToDelete); // fallback
                }

                EditorUtility.SetDirty(graph);
                AssetDatabase.SaveAssets();

                return new { success = true, nodeId = args.nodeId };
            }
            catch (Exception ex)
            {
                return new McpToolError { error = ex.ToString() };
            }
        }

        [McpTool("unity_connect_bt_nodes", "Connect two nodes in a Behavior Graph", typeof(ConnectNodesArgs))]
        public static object ConnectBtNodes(string argsJson)
        {
            var args = JsonUtility.FromJson<ConnectNodesArgs>(argsJson);
            var graph = AssetDatabase.LoadAssetAtPath<ScriptableObject>(args.path);
            if (graph == null) return new McpToolError { error = "Graph not found" };

            try
            {
                var nodesProp = graph.GetType().GetProperty("Nodes");
                var nodesList = nodesProp.GetValue(graph) as System.Collections.IList;
                if (nodesList == null) return new McpToolError { error = "Could not get Nodes list" };

                object sourceNode = null;
                object targetNode = null;

                foreach (var node in nodesList)
                {
                    var idField = node.GetType().GetField("ID");
                    var idVal = idField.GetValue(node);
                    var v0 = idVal.GetType().GetField("m_Value0", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(idVal) ?? 0;
                    var v1 = idVal.GetType().GetField("m_Value1", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(idVal) ?? 0;
                    var v2 = idVal.GetType().GetField("m_Value2", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(idVal) ?? 0;
                    var v3 = idVal.GetType().GetField("m_Value3", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(idVal) ?? 0;
                    string idStr = $"{v0}-{v1}-{v2}-{v3}";
                    
                    if (idStr == args.sourceNodeId) sourceNode = node;
                    if (idStr == args.targetNodeId) targetNode = node;
                }

                if (sourceNode == null) return new McpToolError { error = $"Source node {args.sourceNodeId} not found" };
                if (targetNode == null) return new McpToolError { error = $"Target node {args.targetNodeId} not found" };

                var srcPortsField = sourceNode.GetType().GetField("PortModels", BindingFlags.NonPublic | BindingFlags.Instance);
                var tgtPortsField = targetNode.GetType().GetField("PortModels", BindingFlags.NonPublic | BindingFlags.Instance);
                
                var srcPorts = srcPortsField.GetValue(sourceNode) as System.Collections.IList;
                var tgtPorts = tgtPortsField.GetValue(targetNode) as System.Collections.IList;

                object sourcePort = null;
                object targetPort = null;

                // Find Output port on source
                foreach(var p in srcPorts)
                {
                    var dirProp = p.GetType().GetProperty("Direction");
                    var dirVal = (int)dirProp.GetValue(p);
                    if (dirVal == 1) // Output
                    {
                        sourcePort = p;
                        break;
                    }
                }
                
                // Find Input port on target
                foreach(var p in tgtPorts)
                {
                    var dirProp = p.GetType().GetProperty("Direction");
                    var dirVal = (int)dirProp.GetValue(p);
                    if (dirVal == 0) // Input
                    {
                        targetPort = p;
                        break;
                    }
                }

                if (sourcePort == null) return new McpToolError { error = "Source node has no output port" };
                if (targetPort == null) return new McpToolError { error = "Target node has no input port" };

                var connectMethod = sourcePort.GetType().GetMethod("ConnectTo", BindingFlags.Public | BindingFlags.Instance);
                if (connectMethod == null) return new McpToolError { error = "ConnectTo method not found" };

                connectMethod.Invoke(sourcePort, new object[] { targetPort });

                EditorUtility.SetDirty(graph);
                AssetDatabase.SaveAssets();

                return new { success = true, sourceNodeId = args.sourceNodeId, targetNodeId = args.targetNodeId };
            }
            catch (Exception ex)
            {
                return new McpToolError { error = ex.ToString() };
            }
        }

        [McpTool("unity_set_bt_node_property", "Set a property value on a Behavior Graph node", typeof(SetNodePropertyArgs), Idempotent = true)]
        public static object SetBtNodeProperty(string argsJson)
        {
            var args = JsonUtility.FromJson<SetNodePropertyArgs>(argsJson);
            var graph = AssetDatabase.LoadAssetAtPath<ScriptableObject>(args.path);
            if (graph == null) return new McpToolError { error = "Graph not found" };

            var so = new SerializedObject(graph);
            var nodesProp = so.FindProperty("m_Nodes");
            if (nodesProp == null || !nodesProp.isArray) return new McpToolError { error = "Nodes property not found" };

            SerializedProperty targetNodeProp = null;
            for (int i = 0; i < nodesProp.arraySize; i++)
            {
                var nProp = nodesProp.GetArrayElementAtIndex(i);
                var idProp0 = nProp.FindPropertyRelative("ID.m_Value0");
                var idProp1 = nProp.FindPropertyRelative("ID.m_Value1");
                var idProp2 = nProp.FindPropertyRelative("ID.m_Value2");
                var idProp3 = nProp.FindPropertyRelative("ID.m_Value3");
                if (idProp0 != null)
                {
                    string idStr = $"{idProp0.uintValue}-{idProp1.uintValue}-{idProp2.uintValue}-{idProp3.uintValue}";
                    if (idStr == args.nodeId)
                    {
                        targetNodeProp = nProp;
                        break;
                    }
                }
            }

            if (targetNodeProp == null) return new McpToolError { error = $"Node {args.nodeId} not found" };

            var prop = targetNodeProp.FindPropertyRelative(args.propertyName);
            if (prop == null) return new McpToolError { error = $"Property {args.propertyName} not found on node" };

            try
            {
                if (prop.propertyType == SerializedPropertyType.Integer && int.TryParse(args.value, out int intVal)) prop.intValue = intVal;
                else if (prop.propertyType == SerializedPropertyType.Float && float.TryParse(args.value, out float floatVal)) prop.floatValue = floatVal;
                else if (prop.propertyType == SerializedPropertyType.Boolean && bool.TryParse(args.value, out bool boolVal)) prop.boolValue = boolVal;
                else if (prop.propertyType == SerializedPropertyType.String) prop.stringValue = args.value;
                else return new McpToolError { error = $"Unsupported property type: {prop.propertyType}" };

                so.ApplyModifiedProperties();
                EditorUtility.SetDirty(graph);
                AssetDatabase.SaveAssets();

                return new { success = true, nodeId = args.nodeId, propertyName = args.propertyName, newValue = args.value };
            }
            catch (Exception ex)
            {
                return new McpToolError { error = ex.ToString() };
            }
        }

        private static NodeInfo ParseNode(SerializedProperty nodeProp)
        {
            var info = new NodeInfo();
            info.type = nodeProp.managedReferenceFullTypename.Replace("Unity.Behavior.", "");
            
            var nameProp = nodeProp.FindPropertyRelative("m_Name");
            if (nameProp != null) info.name = nameProp.stringValue;
            
            var posProp = nodeProp.FindPropertyRelative("Position");
            if (posProp != null) info.position = $"({posProp.vector2Value.x:F1}, {posProp.vector2Value.y:F1})";

            var idProp = nodeProp.FindPropertyRelative("ID.m_Value0");
            var idProp1 = nodeProp.FindPropertyRelative("ID.m_Value1");
            var idProp2 = nodeProp.FindPropertyRelative("ID.m_Value2");
            var idProp3 = nodeProp.FindPropertyRelative("ID.m_Value3");
            
            if (idProp != null && idProp1 != null && idProp2 != null && idProp3 != null)
            {
                info.id = $"{idProp.uintValue}-{idProp1.uintValue}-{idProp2.uintValue}-{idProp3.uintValue}";
            }

            var portsProp = nodeProp.FindPropertyRelative("PortModels");
            if (portsProp != null && portsProp.isArray)
            {
                var ports = new List<PortInfo>();
                for (int i = 0; i < portsProp.arraySize; i++)
                {
                    var p = portsProp.GetArrayElementAtIndex(i);
                    var pInfo = new PortInfo();
                    
                    var dirProp = p.FindPropertyRelative("Direction");
                    if (dirProp != null) pInfo.direction = dirProp.enumValueIndex == 0 ? "Input" : "Output";
                    
                    var cProp = p.FindPropertyRelative("Connections");
                    if (cProp != null && cProp.isArray)
                    {
                        var connections = new List<string>();
                        for(int j=0; j<cProp.arraySize; j++)
                        {
                            var conn = cProp.GetArrayElementAtIndex(j);
                            var tNode0 = conn.FindPropertyRelative("TargetNode.m_Value0");
                            var tNode1 = conn.FindPropertyRelative("TargetNode.m_Value1");
                            var tNode2 = conn.FindPropertyRelative("TargetNode.m_Value2");
                            var tNode3 = conn.FindPropertyRelative("TargetNode.m_Value3");
                            if (tNode0 != null) connections.Add($"{tNode0.uintValue}-{tNode1.uintValue}-{tNode2.uintValue}-{tNode3.uintValue}");
                        }
                        pInfo.connectedToNodeIds = connections.ToArray();
                    }
                    ports.Add(pInfo);
                }
                info.ports = ports.ToArray();
            }

            return info;
        }

        private static Type GetTypeByName(string className)
        {
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                var type = assembly.GetType(className, false, true);
                if (type != null) return type;
                if (!className.Contains("."))
                {
                    type = assembly.GetType("Unity.Behavior." + className, false, true);
                    if (type != null) return type;
                    type = assembly.GetType("Unity.Behavior.GraphFramework." + className, false, true);
                    if (type != null) return type;
                }
            }
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                foreach (var t in assembly.GetTypes())
                {
                    if (t.Name.Equals(className, StringComparison.OrdinalIgnoreCase))
                        return t;
                }
            }
            return null;
        }

        // ------------------ Data Types ------------------
        [Serializable] public class GetGraphArgs { [McpParam("Path to the Behavior Graph asset", Required = true)] public string path; }
        
        [Serializable]
        public class AddNodeArgs
        {
            [McpParam("Path to the Behavior Graph asset", Required = true)] public string path;
            [McpParam("Type of the node (e.g. ActionNodeModel, SequenceNodeModel, WaitAction)", Required = true)] public string nodeType;
            [McpParam("Position to place the node")] public Vector3Arg position;
        }

        [Serializable]
        public class Vector3Arg
        {
            public float x; public float y; public float z;
        }

        [Serializable]
        public class RemoveNodeArgs
        {
            [McpParam("Path to the Behavior Graph asset", Required = true)] public string path;
            [McpParam("ID of the node to remove", Required = true)] public string nodeId;
        }

        [Serializable]
        public class ConnectNodesArgs
        {
            [McpParam("Path to the Behavior Graph asset", Required = true)] public string path;
            [McpParam("ID of the source node", Required = true)] public string sourceNodeId;
            [McpParam("ID of the target node", Required = true)] public string targetNodeId;
        }

        [Serializable]
        public class SetNodePropertyArgs
        {
            [McpParam("Path to the Behavior Graph asset", Required = true)] public string path;
            [McpParam("ID of the node to modify", Required = true)] public string nodeId;
            [McpParam("Name of the property to set", Required = true)] public string propertyName;
            [McpParam("New value for the property", Required = true)] public string value;
        }

        [Serializable]
        public class GraphResult
        {
            public string path;
            public string blackboardName;
            public int nodeCount;
            public NodeInfo[] nodes;
        }

        [Serializable]
        public class NodeInfo
        {
            public string id;
            public string type;
            public string name;
            public string position;
            public PortInfo[] ports;
        }

        [Serializable]
        public class PortInfo
        {
            public string direction;
            public string[] connectedToNodeIds;
        }
    }
}
