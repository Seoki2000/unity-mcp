using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace Community.Unity.MCP
{
    /// <summary>
    /// MCP tools for creating and modifying GameObjects.
    /// </summary>
    [McpToolProvider]
    public class GameObjectTools
    {
        [McpTool("unity_create_gameobject", "Create a new GameObject in the scene", typeof(CreateGameObjectArgs))]
        public static object CreateGameObject(string argsJson)
        {
            var args = JsonUtility.FromJson<CreateGameObjectArgs>(argsJson);
            
            string name = string.IsNullOrEmpty(args?.name) ? "New GameObject" : args.name;
            
            GameObject go;
            
            // Create primitive if specified
            if (!string.IsNullOrEmpty(args?.primitiveType))
            {
                if (Enum.TryParse<PrimitiveType>(args.primitiveType, true, out var primitive))
                {
                    go = GameObject.CreatePrimitive(primitive);
                    go.name = name;
                }
                else
                {
                    return new McpToolError { error = $"Invalid primitive type: {args.primitiveType}. Valid types: Cube, Sphere, Capsule, Cylinder, Plane, Quad" };
                }
            }
            else
            {
                go = new GameObject(name);
            }
            
            // Set parent if specified
            if (!string.IsNullOrEmpty(args?.parentPath))
            {
                var parent = GameObject.Find(args.parentPath);
                if (parent != null)
                {
                    go.transform.SetParent(parent.transform, false);
                }
                else
                {
                    return new CreateGameObjectParentError { error = $"Parent not found: {args.parentPath}", gameObjectCreated = true, name = go.name };
                }
            }
            // Set transform if specified
            // Note: Position and rotation (0,0,0) are valid values, so we set them anyway
            // But we DON'T check for zero since JsonUtility treats unset Vec3 as (0,0,0) which is fine for position/rotation
            if (args?.position != null)
            {
                go.transform.position = new Vector3(args.position.x, args.position.y, args.position.z);
            }
            if (args?.rotation != null)
            {
                go.transform.eulerAngles = new Vector3(args.rotation.x, args.rotation.y, args.rotation.z);
            }
            // Only set scale if it has non-zero values (JsonUtility defaults to 0,0,0 which would make object invisible)
            // A scale of (0,0,0) is almost never wanted, so we skip it
            if (args?.scale != null && !IsZeroVec3(args.scale))
            {
                go.transform.localScale = new Vector3(args.scale.x, args.scale.y, args.scale.z);
            }
            
            // Register undo
            Undo.RegisterCreatedObjectUndo(go, $"Create {name}");
            
            // Select the new object
            Selection.activeGameObject = go;
            
            return new CreateGameObjectResult
            {
                success = true,
                name = go.name,
                path = GetGameObjectPath(go),
                instanceId = go.GetInstanceID()
            };
        }

        [McpTool("unity_delete_gameobject", "Delete a GameObject from the scene", typeof(DeleteGameObjectArgs))]
        public static object DeleteGameObject(string argsJson)
        {
            var args = JsonUtility.FromJson<DeleteGameObjectArgs>(argsJson);
            
            if (string.IsNullOrEmpty(args?.path))
            {
                return new McpToolError { error = "path parameter is required" };
            }
            
            var go = GameObject.Find(args.path);
            if (go == null)
            {
                return new McpToolError { error = $"GameObject not found: {args.path}" };
            }
            
            string deletedName = go.name;
            string deletedPath = GetGameObjectPath(go);
            
            // Register undo
            Undo.DestroyObjectImmediate(go);
            
            return new DeleteGameObjectResult
            {
                success = true,
                deletedName = deletedName,
                deletedPath = deletedPath
            };
        }

        [McpTool("unity_set_transform", "Set the transform (position, rotation, scale) of a GameObject", typeof(SetTransformArgs))]
        public static object SetTransform(string argsJson)
        {
            var args = JsonUtility.FromJson<SetTransformArgs>(argsJson);
            
            if (string.IsNullOrEmpty(args?.path))
            {
                return new McpToolError { error = "path parameter is required" };
            }
            
            var go = GameObject.Find(args.path);
            if (go == null)
            {
                return new McpToolError { error = $"GameObject not found: {args.path}" };
            }
            
            Undo.RecordObject(go.transform, $"Set Transform {go.name}");
            
            bool changed = false;
            
            if (args.position != null)
            {
                if (args.useLocalSpace)
                    go.transform.localPosition = new Vector3(args.position.x, args.position.y, args.position.z);
                else
                    go.transform.position = new Vector3(args.position.x, args.position.y, args.position.z);
                changed = true;
            }
            
            if (args.rotation != null)
            {
                if (args.useLocalSpace)
                    go.transform.localEulerAngles = new Vector3(args.rotation.x, args.rotation.y, args.rotation.z);
                else
                    go.transform.eulerAngles = new Vector3(args.rotation.x, args.rotation.y, args.rotation.z);
                changed = true;
            }
            
            // Only set scale if non-zero (JsonUtility defaults to 0,0,0 which would make object invisible)
            if (args.scale != null && !IsZeroVec3(args.scale))
            {
                go.transform.localScale = new Vector3(args.scale.x, args.scale.y, args.scale.z);
                changed = true;
            }
            
            return new SetTransformResult
            {
                success = true,
                path = args.path,
                changed = changed,
                newPosition = go.transform.position.ToString(),
                newRotation = go.transform.eulerAngles.ToString(),
                newScale = go.transform.localScale.ToString()
            };
        }

        [McpTool("unity_add_component", "Add a component to a GameObject", typeof(AddComponentArgs))]
        public static object AddComponent(string argsJson)
        {
            var args = JsonUtility.FromJson<AddComponentArgs>(argsJson);
            
            if (string.IsNullOrEmpty(args?.path))
            {
                return new McpToolError { error = "path parameter is required" };
            }
            if (string.IsNullOrEmpty(args?.componentType))
            {
                return new McpToolError { error = "componentType parameter is required" };
            }
            
            var go = GameObject.Find(args.path);
            if (go == null)
            {
                return new McpToolError { error = $"GameObject not found: {args.path}" };
            }
            
            // Try to find the type
            Type componentType = FindComponentType(args.componentType);
            if (componentType == null)
            {
                return new McpToolError { error = $"Component type not found: {args.componentType}. Try using full type name like 'UnityEngine.Rigidbody'" };
            }
            
            // Check if component already exists (for non-multi components)
            var existing = go.GetComponent(componentType);
            if (existing != null && !AllowsMultiple(componentType))
            {
                return new AddComponentExistsError { error = $"GameObject already has component: {args.componentType}", alreadyExists = true };
            }
            
            // Add the component
            var component = Undo.AddComponent(go, componentType);
            
            return new AddComponentResult
            {
                success = true,
                path = args.path,
                componentType = componentType.Name,
                fullTypeName = componentType.FullName
            };
        }

        [McpTool("unity_remove_component", "Remove a component from a GameObject", typeof(RemoveComponentArgs))]
        public static object RemoveComponent(string argsJson)
        {
            var args = JsonUtility.FromJson<RemoveComponentArgs>(argsJson);
            
            if (string.IsNullOrEmpty(args?.path))
            {
                return new McpToolError { error = "path parameter is required" };
            }
            if (string.IsNullOrEmpty(args?.componentType))
            {
                return new McpToolError { error = "componentType parameter is required" };
            }
            
            var go = GameObject.Find(args.path);
            if (go == null)
            {
                return new McpToolError { error = $"GameObject not found: {args.path}" };
            }
            
            Type componentType = FindComponentType(args.componentType);
            if (componentType == null)
            {
                return new McpToolError { error = $"Component type not found: {args.componentType}" };
            }
            
            var component = go.GetComponent(componentType);
            if (component == null)
            {
                return new McpToolError { error = $"Component not found on GameObject: {args.componentType}" };
            }
            
            // Can't remove Transform
            if (componentType == typeof(Transform))
            {
                return new McpToolError { error = "Cannot remove Transform component" };
            }
            
            Undo.DestroyObjectImmediate(component);
            
            return new RemoveComponentResult
            {
                success = true,
                path = args.path,
                removedType = componentType.Name
            };
        }

        [McpTool("unity_set_component_property", "Set a property value on a component", typeof(SetPropertyArgs))]
        public static object SetComponentProperty(string argsJson)
        {
            var args = JsonUtility.FromJson<SetPropertyArgs>(argsJson);
            
            if (string.IsNullOrEmpty(args?.path))
                return new McpToolError { error = "path parameter is required" };
            if (string.IsNullOrEmpty(args?.componentType))
                return new McpToolError { error = "componentType parameter is required" };
            if (string.IsNullOrEmpty(args?.propertyName))
                return new McpToolError { error = "propertyName parameter is required" };
            
            var go = GameObject.Find(args.path);
            if (go == null)
                return new McpToolError { error = $"GameObject not found: {args.path}" };
            
            Type componentType = FindComponentType(args.componentType);
            if (componentType == null)
                return new McpToolError { error = $"Component type not found: {args.componentType}" };
            
            var comp = go.GetComponent(componentType);
            if (comp == null)
                return new McpToolError { error = $"Component {args.componentType} not found on GameObject" };
            
            var serializedObject = new SerializedObject(comp);
            var property = serializedObject.FindProperty(args.propertyName);
            
            if (property == null)
                return new McpToolError { error = $"Property {args.propertyName} not found on component {args.componentType}" };
            
            try
            {
                // Simple parsing for basic types
                if (property.propertyType == SerializedPropertyType.Integer && int.TryParse(args.value, out int intVal))
                    property.intValue = intVal;
                else if (property.propertyType == SerializedPropertyType.Float && float.TryParse(args.value, out float floatVal))
                    property.floatValue = floatVal;
                else if (property.propertyType == SerializedPropertyType.Boolean && bool.TryParse(args.value, out bool boolVal))
                    property.boolValue = boolVal;
                else if (property.propertyType == SerializedPropertyType.String)
                    property.stringValue = args.value;
                else
                    return new McpToolError { error = $"Unsupported property type for string assignment: {property.propertyType}" };
                
                serializedObject.ApplyModifiedProperties();
                
                return new SetPropertyResult
                {
                    success = true,
                    path = args.path,
                    componentType = componentType.Name,
                    propertyName = args.propertyName,
                    newValue = args.value
                };
            }
            catch (Exception ex)
            {
                return new McpToolError { error = $"Failed to set property: {ex.Message}" };
            }
        }

        [McpTool("unity_get_component_properties", "Get the serialized properties of a component", typeof(GetComponentPropertiesArgs))]
        public static object GetComponentProperties(string argsJson)
        {
            var args = JsonUtility.FromJson<GetComponentPropertiesArgs>(argsJson);
            if (string.IsNullOrEmpty(args?.path))
                return new McpToolError { error = "path parameter is required" };
            if (string.IsNullOrEmpty(args?.componentType))
                return new McpToolError { error = "componentType parameter is required" };

            var go = GameObject.Find(args.path);
            if (go == null)
                return new McpToolError { error = $"GameObject not found: {args.path}" };

            var compType = FindComponentType(args.componentType);
            if (compType == null)
                return new McpToolError { error = $"Component type not found: {args.componentType}" };

            var comp = go.GetComponent(compType);
            if (comp == null)
                return new McpToolError { error = $"Component {args.componentType} not found on {args.path}" };

            var serializedObj = new SerializedObject(comp);
            var prop = serializedObj.GetIterator();
            var properties = new List<ComponentPropertyInfo>();

            if (prop.NextVisible(true))
            {
                do
                {
                    if (prop.name == "m_Script") continue;

                    properties.Add(new ComponentPropertyInfo
                    {
                        name = prop.name,
                        type = prop.propertyType.ToString(),
                        value = GetSerializedPropertyValue(prop)
                    });
                } while (prop.NextVisible(false));
            }

            return new ComponentPropertiesResult
            {
                gameObjectPath = args.path,
                componentType = compType.Name,
                properties = properties.ToArray()
            };
        }

        private static string GetSerializedPropertyValue(SerializedProperty prop)
        {
            switch (prop.propertyType)
            {
                case SerializedPropertyType.Integer: return prop.intValue.ToString();
                case SerializedPropertyType.Boolean: return prop.boolValue.ToString();
                case SerializedPropertyType.Float: return prop.floatValue.ToString();
                case SerializedPropertyType.String: return prop.stringValue;
                case SerializedPropertyType.Color: return prop.colorValue.ToString();
                case SerializedPropertyType.ObjectReference: return prop.objectReferenceValue != null ? prop.objectReferenceValue.name : "null";
                case SerializedPropertyType.Vector2: return prop.vector2Value.ToString();
                case SerializedPropertyType.Vector3: return prop.vector3Value.ToString();
                case SerializedPropertyType.Enum: return prop.enumNames.Length > prop.enumValueIndex && prop.enumValueIndex >= 0 ? prop.enumNames[prop.enumValueIndex] : prop.enumValueIndex.ToString();
                default: return "UnsupportedType: " + prop.propertyType.ToString();
            }
        }

        #region Helper Methods

        private static string GetGameObjectPath(GameObject go)
        {
            string path = go.name;
            var parent = go.transform.parent;
            while (parent != null)
            {
                path = parent.name + "/" + path;
                parent = parent.parent;
            }
            return path;
        }

        private static bool IsZeroVec3(Vec3 v)
        {
            if (v == null) return true;
            return v.x == 0 && v.y == 0 && v.z == 0;
        }

        private static Type FindComponentType(string typeName)
        {
            // Try direct lookup first
            Type type = Type.GetType(typeName);
            if (type != null && typeof(Component).IsAssignableFrom(type))
                return type;
            
            // Try UnityEngine namespace
            type = Type.GetType($"UnityEngine.{typeName}, UnityEngine");
            if (type != null && typeof(Component).IsAssignableFrom(type))
                return type;
            
            // Try UnityEngine.UI
            type = Type.GetType($"UnityEngine.UI.{typeName}, UnityEngine.UI");
            if (type != null && typeof(Component).IsAssignableFrom(type))
                return type;
            
            // Search all loaded assemblies
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    foreach (var t in assembly.GetTypes())
                    {
                        if ((t.Name == typeName || t.FullName == typeName) && typeof(Component).IsAssignableFrom(t))
                        {
                            return t;
                        }
                    }
                }
                catch { }
            }
            
            return null;
        }

        private static bool AllowsMultiple(Type componentType)
        {
            return Attribute.IsDefined(componentType, typeof(DisallowMultipleComponent)) == false;
        }

        private static void SetSerializedPropertyValue(SerializedProperty property, string value)
        {
            switch (property.propertyType)
            {
                case SerializedPropertyType.Integer:
                    property.intValue = int.Parse(value);
                    break;
                case SerializedPropertyType.Float:
                    property.floatValue = float.Parse(value);
                    break;
                case SerializedPropertyType.Boolean:
                    property.boolValue = bool.Parse(value);
                    break;
                case SerializedPropertyType.String:
                    property.stringValue = value;
                    break;
                case SerializedPropertyType.Enum:
                    property.enumValueIndex = int.Parse(value);
                    break;
                case SerializedPropertyType.Color:
                    // Expect format: "r,g,b,a"
                    var colorParts = value.Split(',');
                    if (colorParts.Length >= 3)
                    {
                        property.colorValue = new Color(
                            float.Parse(colorParts[0]),
                            float.Parse(colorParts[1]),
                            float.Parse(colorParts[2]),
                            colorParts.Length > 3 ? float.Parse(colorParts[3]) : 1f
                        );
                    }
                    break;
                case SerializedPropertyType.Vector2:
                    var v2Parts = value.Split(',');
                    if (v2Parts.Length >= 2)
                        property.vector2Value = new Vector2(float.Parse(v2Parts[0]), float.Parse(v2Parts[1]));
                    break;
                case SerializedPropertyType.Vector3:
                    var v3Parts = value.Split(',');
                    if (v3Parts.Length >= 3)
                        property.vector3Value = new Vector3(float.Parse(v3Parts[0]), float.Parse(v3Parts[1]), float.Parse(v3Parts[2]));
                    break;
                default:
                    throw new NotSupportedException($"Property type {property.propertyType} is not supported");
            }
        }

        #endregion

        #region Data Types

        [Serializable]
        public class Vec3
        {
            public float x;
            public float y;
            public float z;
        }

        [Serializable]
        public class CreateGameObjectArgs
        {
            [McpParam("Name of the GameObject")] public string name;
            [McpParam("Path to parent GameObject")] public string parentPath;
            [McpParam("Primitive type", EnumValues = new[] { "Cube", "Sphere", "Capsule", "Cylinder", "Plane", "Quad" })] public string primitiveType;
            [McpParam("World position {x, y, z}")] public Vec3 position;
            [McpParam("Rotation in euler angles {x, y, z}")] public Vec3 rotation;
            [McpParam("Local scale {x, y, z}")] public Vec3 scale;
        }

        [Serializable]
        public class CreateGameObjectResult
        {
            public bool success;
            public string name;
            public string path;
            public int instanceId;
        }

        [Serializable]
        public class CreateGameObjectParentError : McpToolError
        {
            public bool gameObjectCreated;
            public string name;
        }

        [Serializable]
        public class DeleteGameObjectArgs
        {
            [McpParam("Path to the GameObject to delete", Required = true)] public string path;
        }

        [Serializable]
        public class DeleteGameObjectResult
        {
            public bool success;
            public string deletedName;
            public string deletedPath;
        }

        [Serializable]
        public class SetTransformArgs
        {
            [McpParam("Path to the GameObject", Required = true)] public string path;
            [McpParam("New position {x, y, z}")] public Vec3 position;
            [McpParam("New rotation in euler angles {x, y, z}")] public Vec3 rotation;
            [McpParam("New local scale {x, y, z}")] public Vec3 scale;
            [McpParam("Use local space instead of world space")] public bool useLocalSpace;
        }

        [Serializable]
        public class SetTransformResult
        {
            public bool success;
            public string path;
            public bool changed;
            public string newPosition;
            public string newRotation;
            public string newScale;
        }

        [Serializable]
        public class AddComponentArgs
        {
            [McpParam("Path to the GameObject", Required = true)] public string path;
            [McpParam("Component type name (e.g., 'Rigidbody', 'BoxCollider')", Required = true)] public string componentType;
        }

        [Serializable]
        public class AddComponentResult
        {
            public bool success;
            public string path;
            public string componentType;
            public string fullTypeName;
        }

        [Serializable]
        public class AddComponentExistsError : McpToolError
        {
            public bool alreadyExists;
        }

        [Serializable]
        public class RemoveComponentArgs
        {
            [McpParam("Path to the GameObject", Required = true)] public string path;
            [McpParam("Component type name to remove", Required = true)] public string componentType;
        }

        [Serializable]
        public class RemoveComponentResult
        {
            public bool success;
            public string path;
            public string removedType;
        }

        [Serializable]
        public class SetPropertyArgs
        {
            [McpParam("Path to the GameObject", Required = true)] public string path;
            [McpParam("Component type name", Required = true)] public string componentType;
            [McpParam("Property name to set", Required = true)] public string propertyName;
            [McpParam("Value to set (as string, will be parsed)")] public string value;
        }

        [Serializable]
        public class SetPropertyResult
        {
            public bool success;
            public string path;
            public string componentType;
            public string propertyName;
            public string newValue;
        }

        [Serializable]
        public class GetComponentPropertiesArgs
        {
            [McpParam("Path to the GameObject", Required = true)] public string path;
            [McpParam("Type name of the component", Required = true)] public string componentType;
        }

        [Serializable]
        public class ComponentPropertyInfo
        {
            public string name;
            public string type;
            public string value;
        }

        [Serializable]
        public class ComponentPropertiesResult
        {
            public string gameObjectPath;
            public string componentType;
            public ComponentPropertyInfo[] properties;
        }

        #endregion
    }
}
