using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Community.Unity.MCP
{
    /// <summary>
    /// MCP tools for providing AI agents with rich context about the project.
    /// </summary>
    [McpToolProvider]
    public class ContextTools
    {
        [McpTool("unity_get_scene_summary", "Get a compact summary of the current scene for AI context", ReadOnly = true)]
        public static object GetSceneSummary(string argsJson)
        {
            var scene = SceneManager.GetActiveScene();
            var rootObjects = scene.GetRootGameObjects();
            
            int totalGameObjects = 0;
            int totalComponents = 0;
            var componentCounts = new Dictionary<string, int>();
            var keyObjects = new List<KeyObjectInfo>();
            
            foreach (var root in rootObjects)
            {
                CountHierarchy(root, ref totalGameObjects, ref totalComponents, componentCounts, keyObjects, 0);
            }
            
            // Get top components by count
            var topComponents = componentCounts
                .OrderByDescending(kvp => kvp.Value)
                .Take(10)
                .Select(kvp => new ComponentCount { type = kvp.Key, count = kvp.Value })
                .ToArray();
            
            return new SceneSummaryResult
            {
                sceneName = scene.name,
                scenePath = scene.path,
                rootObjectCount = rootObjects.Length,
                totalGameObjects = totalGameObjects,
                totalComponents = totalComponents,
                topComponents = topComponents,
                keyObjects = keyObjects.Take(20).ToArray()
            };
        }

        [McpTool("unity_get_component_schema", "Get all serializable properties of a component type", typeof(GetComponentSchemaArgs), ReadOnly = true)]
        public static object GetComponentSchema(string argsJson)
        {
            var args = JsonUtility.FromJson<GetComponentSchemaArgs>(argsJson);
            
            if (string.IsNullOrEmpty(args?.componentType))
                return new McpToolError { error = "componentType parameter is required" };
            
            // Find the type
            Type type = FindType(args.componentType);
            if (type == null)
                return new McpToolError { error = $"Type not found: {args.componentType}" };
            
            var properties = new List<PropertySchema>();
            
            // Get serialized fields
            var fields = type.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            foreach (var field in fields)
            {
                bool isSerializable = field.IsPublic || field.GetCustomAttribute<SerializeField>() != null;
                if (!isSerializable) continue;
                if (field.GetCustomAttribute<HideInInspector>() != null) continue;
                
                properties.Add(new PropertySchema
                {
                    name = field.Name,
                    type = GetFriendlyTypeName(field.FieldType),
                    isPublic = field.IsPublic,
                    hasRange = field.GetCustomAttribute<RangeAttribute>() != null,
                    hasTooltip = field.GetCustomAttribute<TooltipAttribute>() != null,
                    tooltip = field.GetCustomAttribute<TooltipAttribute>()?.tooltip
                });
            }
            
            // Get public properties
            var props = type.GetProperties(BindingFlags.Public | BindingFlags.Instance);
            foreach (var prop in props)
            {
                if (!prop.CanRead) continue;
                if (prop.GetIndexParameters().Length > 0) continue; // Skip indexers
                
                properties.Add(new PropertySchema
                {
                    name = prop.Name,
                    type = GetFriendlyTypeName(prop.PropertyType),
                    isPublic = true,
                    isProperty = true,
                    canWrite = prop.CanWrite
                });
            }
            
            return new ComponentSchemaResult
            {
                // 짧은 이름이 겹치면 어느 타입을 봤는지 알려준다. 기존엔 조용히 아무거나 골랐다.
                note = IsAmbiguousTypeName(args.componentType)
                    ? $"'{args.componentType}' matches multiple types; resolved to '{type.FullName}'. Pass the full name to disambiguate."
                    : null,
                componentType = type.Name,
                fullTypeName = type.FullName,
                baseType = type.BaseType?.Name,
                isMonoBehaviour = typeof(MonoBehaviour).IsAssignableFrom(type),
                propertyCount = properties.Count,
                properties = properties.ToArray()
            };
        }

        [McpTool("unity_get_type_info", "Get available Unity component types or search for types", typeof(GetTypeInfoArgs), ReadOnly = true)]
        public static object GetTypeInfo(string argsJson)
        {
            var args = JsonUtility.FromJson<GetTypeInfoArgs>(argsJson);
            
            string category = string.IsNullOrEmpty(args?.category) ? "common" : args.category.ToLower();
            string searchQuery = args?.search?.ToLower();
            int maxResults = args?.maxResults > 0 ? args.maxResults : 50;
            
            var types = new List<TypeInfoEntry>();
            
            switch (category)
            {
                case "common":
                    types.AddRange(GetCommonTypes());
                    break;
                case "physics":
                    types.AddRange(GetPhysicsTypes());
                    break;
                case "rendering":
                    types.AddRange(GetRenderingTypes());
                    break;
                case "ui":
                    types.AddRange(GetUITypes());
                    break;
                case "audio":
                    types.AddRange(GetAudioTypes());
                    break;
                case "all":
                case "search":
                    types.AddRange(GetAllComponentTypes(searchQuery, maxResults));
                    break;
                default:
                    return new McpToolError { error = $"Unknown category: {category}. Use: common, physics, rendering, ui, audio, all, search" };
            }
            
            // Apply search filter
            if (!string.IsNullOrEmpty(searchQuery) && category != "all" && category != "search")
            {
                types = types.Where(t => t.name.ToLower().Contains(searchQuery)).ToList();
            }
            
            return new GetTypeInfoResult
            {
                category = category,
                search = searchQuery,
                count = types.Count,
                types = types.Take(maxResults).ToArray()
            };
        }

        #region Helper Methods

        private static void CountHierarchy(GameObject go, ref int totalObjects, ref int totalComponents, 
            Dictionary<string, int> componentCounts, List<KeyObjectInfo> keyObjects, int depth)
        {
            totalObjects++;
            
            var components = go.GetComponents<Component>();
            totalComponents += components.Length;
            
            // Track component types
            foreach (var comp in components)
            {
                if (comp == null) continue;
                string typeName = comp.GetType().Name;
                if (!componentCounts.ContainsKey(typeName))
                    componentCounts[typeName] = 0;
                componentCounts[typeName]++;
            }
            
            // Identify key objects (cameras, lights, special components)
            bool isKey = go.GetComponent<Camera>() != null ||
                         go.GetComponent<Light>() != null ||
                         go.GetComponent<Canvas>() != null ||
                         go.GetComponent<AudioSource>() != null ||
                         go.name.Contains("Manager") ||
                         go.name.Contains("Controller") ||
                         go.name.Contains("Player");
            
            if (isKey)
            {
                var mainComponent = components.FirstOrDefault(c => c != null && !(c is Transform));
                keyObjects.Add(new KeyObjectInfo
                {
                    name = go.name,
                    path = GetGameObjectPath(go),
                    mainComponent = mainComponent?.GetType().Name ?? "None",
                    childCount = go.transform.childCount,
                    isActive = go.activeInHierarchy
                });
            }
            
            // Recurse into children (limit depth for performance)
            if (depth < 10)
            {
                foreach (Transform child in go.transform)
                {
                    CountHierarchy(child.gameObject, ref totalObjects, ref totalComponents, componentCounts, keyObjects, depth + 1);
                }
            }
        }

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

        // 타입 이름 → 타입. 도메인 리로드마다 1회만 구축한다.
        // 기존 구현은 매 호출마다 AppDomain 전체를 순회하며 assembly.GetTypes() 를 호출했고
        // (수만 개 타입), 동명 타입이 있으면 어셈블리 순서에 따라 조용히 아무거나 골랐다.
        private static Dictionary<string, Type> _typeByShortName;
        private static Dictionary<string, Type> _typeByFullName;
        private static readonly HashSet<string> _ambiguousShortNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        private static void BuildTypeIndex()
        {
            if (_typeByShortName != null) return;

            _typeByShortName = new Dictionary<string, Type>(StringComparer.OrdinalIgnoreCase);
            _typeByFullName = new Dictionary<string, Type>(StringComparer.OrdinalIgnoreCase);

            // TypeCache 는 Unity 가 이미 만들어 둔 인덱스라 GetTypes() 전수 순회보다 훨씬 싸다.
            foreach (var t in TypeCache.GetTypesDerivedFrom<object>())
            {
                if (t == null) continue;

                if (!string.IsNullOrEmpty(t.FullName) && !_typeByFullName.ContainsKey(t.FullName))
                {
                    _typeByFullName[t.FullName] = t;
                }

                if (_typeByShortName.TryGetValue(t.Name, out var existing))
                {
                    // 짧은 이름이 겹치면 모호하다고 표시하고, UnityEngine 계열을 우선한다
                    // (예: 사용자 코드의 'Camera' 보다 UnityEngine.Camera).
                    if (existing != t) _ambiguousShortNames.Add(t.Name);
                    bool existingIsUnity = existing.Namespace != null && existing.Namespace.StartsWith("UnityEngine", StringComparison.Ordinal);
                    bool candidateIsUnity = t.Namespace != null && t.Namespace.StartsWith("UnityEngine", StringComparison.Ordinal);
                    if (candidateIsUnity && !existingIsUnity) _typeByShortName[t.Name] = t;
                }
                else
                {
                    _typeByShortName[t.Name] = t;
                }
            }
        }

        private static Type FindType(string typeName)
        {
            if (string.IsNullOrEmpty(typeName)) return null;

            // 정확한 어셈블리 수식 이름이면 그대로
            var type = Type.GetType(typeName);
            if (type != null) return type;

            BuildTypeIndex();

            if (_typeByFullName.TryGetValue(typeName, out type)) return type;
            if (_typeByShortName.TryGetValue(typeName, out type)) return type;

            return null;
        }

        /// <summary>짧은 이름이 여러 타입과 겹치는지. 응답에 경고를 실을 때 쓴다.</summary>
        private static bool IsAmbiguousTypeName(string typeName)
        {
            BuildTypeIndex();
            return _ambiguousShortNames.Contains(typeName);
        }

        private static string GetFriendlyTypeName(Type type)
        {
            if (type == typeof(int)) return "int";
            if (type == typeof(float)) return "float";
            if (type == typeof(bool)) return "bool";
            if (type == typeof(string)) return "string";
            if (type == typeof(Vector2)) return "Vector2";
            if (type == typeof(Vector3)) return "Vector3";
            if (type == typeof(Color)) return "Color";
            if (type == typeof(GameObject)) return "GameObject";
            if (type.IsArray) return $"{GetFriendlyTypeName(type.GetElementType())}[]";
            if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(List<>))
                return $"List<{GetFriendlyTypeName(type.GetGenericArguments()[0])}>";
            return type.Name;
        }

        private static List<TypeInfoEntry> GetCommonTypes()
        {
            return new List<TypeInfoEntry>
            {
                new TypeInfoEntry { name = "Transform", category = "Core" },
                new TypeInfoEntry { name = "Rigidbody", category = "Physics" },
                new TypeInfoEntry { name = "BoxCollider", category = "Physics" },
                new TypeInfoEntry { name = "SphereCollider", category = "Physics" },
                new TypeInfoEntry { name = "CapsuleCollider", category = "Physics" },
                new TypeInfoEntry { name = "MeshCollider", category = "Physics" },
                new TypeInfoEntry { name = "MeshRenderer", category = "Rendering" },
                new TypeInfoEntry { name = "MeshFilter", category = "Rendering" },
                new TypeInfoEntry { name = "Camera", category = "Rendering" },
                new TypeInfoEntry { name = "Light", category = "Rendering" },
                new TypeInfoEntry { name = "AudioSource", category = "Audio" },
                new TypeInfoEntry { name = "Animator", category = "Animation" },
                new TypeInfoEntry { name = "Canvas", category = "UI" },
                new TypeInfoEntry { name = "CharacterController", category = "Physics" },
            };
        }

        private static List<TypeInfoEntry> GetPhysicsTypes()
        {
            return new List<TypeInfoEntry>
            {
                new TypeInfoEntry { name = "Rigidbody", category = "Physics" },
                new TypeInfoEntry { name = "Rigidbody2D", category = "Physics2D" },
                new TypeInfoEntry { name = "BoxCollider", category = "Collider" },
                new TypeInfoEntry { name = "SphereCollider", category = "Collider" },
                new TypeInfoEntry { name = "CapsuleCollider", category = "Collider" },
                new TypeInfoEntry { name = "MeshCollider", category = "Collider" },
                new TypeInfoEntry { name = "BoxCollider2D", category = "Collider2D" },
                new TypeInfoEntry { name = "CircleCollider2D", category = "Collider2D" },
                new TypeInfoEntry { name = "CharacterController", category = "Controller" },
                new TypeInfoEntry { name = "Joint", category = "Joint" },
                new TypeInfoEntry { name = "HingeJoint", category = "Joint" },
                new TypeInfoEntry { name = "SpringJoint", category = "Joint" },
            };
        }

        private static List<TypeInfoEntry> GetRenderingTypes()
        {
            return new List<TypeInfoEntry>
            {
                new TypeInfoEntry { name = "Camera", category = "Camera" },
                new TypeInfoEntry { name = "Light", category = "Light" },
                new TypeInfoEntry { name = "MeshRenderer", category = "Renderer" },
                new TypeInfoEntry { name = "SkinnedMeshRenderer", category = "Renderer" },
                new TypeInfoEntry { name = "SpriteRenderer", category = "Renderer" },
                new TypeInfoEntry { name = "LineRenderer", category = "Renderer" },
                new TypeInfoEntry { name = "TrailRenderer", category = "Renderer" },
                new TypeInfoEntry { name = "ParticleSystem", category = "Particles" },
                new TypeInfoEntry { name = "ReflectionProbe", category = "Probe" },
                new TypeInfoEntry { name = "LightProbeGroup", category = "Probe" },
            };
        }

        private static List<TypeInfoEntry> GetUITypes()
        {
            return new List<TypeInfoEntry>
            {
                new TypeInfoEntry { name = "Canvas", category = "Core" },
                new TypeInfoEntry { name = "CanvasScaler", category = "Core" },
                new TypeInfoEntry { name = "GraphicRaycaster", category = "Core" },
                new TypeInfoEntry { name = "Button", category = "Control" },
                new TypeInfoEntry { name = "Toggle", category = "Control" },
                new TypeInfoEntry { name = "Slider", category = "Control" },
                new TypeInfoEntry { name = "Dropdown", category = "Control" },
                new TypeInfoEntry { name = "InputField", category = "Control" },
                new TypeInfoEntry { name = "Text", category = "Display" },
                new TypeInfoEntry { name = "Image", category = "Display" },
                new TypeInfoEntry { name = "RawImage", category = "Display" },
                new TypeInfoEntry { name = "ScrollRect", category = "Layout" },
            };
        }

        private static List<TypeInfoEntry> GetAudioTypes()
        {
            return new List<TypeInfoEntry>
            {
                new TypeInfoEntry { name = "AudioSource", category = "Source" },
                new TypeInfoEntry { name = "AudioListener", category = "Listener" },
                new TypeInfoEntry { name = "AudioReverbZone", category = "Effect" },
                new TypeInfoEntry { name = "AudioChorusFilter", category = "Filter" },
                new TypeInfoEntry { name = "AudioDistortionFilter", category = "Filter" },
                new TypeInfoEntry { name = "AudioEchoFilter", category = "Filter" },
                new TypeInfoEntry { name = "AudioHighPassFilter", category = "Filter" },
                new TypeInfoEntry { name = "AudioLowPassFilter", category = "Filter" },
            };
        }

        private static List<TypeInfoEntry> GetAllComponentTypes(string searchQuery, int maxResults)
        {
            var types = new List<TypeInfoEntry>();
            
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    foreach (var type in assembly.GetTypes())
                    {
                        if (!typeof(Component).IsAssignableFrom(type)) continue;
                        if (type.IsAbstract) continue;
                        
                        if (!string.IsNullOrEmpty(searchQuery) && 
                            !type.Name.ToLower().Contains(searchQuery))
                            continue;
                        
                        types.Add(new TypeInfoEntry
                        {
                            name = type.Name,
                            category = type.Namespace ?? "Unknown"
                        });
                        
                        if (types.Count >= maxResults) return types;
                    }
                }
                catch
                {
                    // Skip problematic assemblies
                }
            }
            
            return types;
        }

        #endregion

        #region Data Types

        [Serializable]
        public class ComponentCount
        {
            public string type;
            public int count;
        }

        [Serializable]
        public class KeyObjectInfo
        {
            public string name;
            public string path;
            public string mainComponent;
            public int childCount;
            public bool isActive;
        }

        [Serializable]
        public class SceneSummaryResult
        {
            public string sceneName;
            public string scenePath;
            public int rootObjectCount;
            public int totalGameObjects;
            public int totalComponents;
            public ComponentCount[] topComponents;
            public KeyObjectInfo[] keyObjects;
        }

        [Serializable]
        public class GetComponentSchemaArgs
        {
            [McpParam("Component type name (e.g., 'Rigidbody', 'Camera')", Required = true)] public string componentType;
        }

        [Serializable]
        public class PropertySchema
        {
            public string name;
            public string type;
            public bool isPublic;
            public bool isProperty;
            public bool canWrite;
            public bool hasRange;
            public bool hasTooltip;
            public string tooltip;
        }

        [Serializable]
        public class ComponentSchemaResult
        {
            public string componentType;
            public string fullTypeName;
            public string baseType;
            public bool isMonoBehaviour;
            public int propertyCount;
            public string note;   // 짧은 타입 이름이 여러 타입과 겹칠 때 경고
            public PropertySchema[] properties;
        }

        [Serializable]
        public class GetTypeInfoArgs
        {
            [McpParam("Type category", EnumValues = new[] { "common", "physics", "rendering", "ui", "audio", "all", "search" })] public string category;
            [McpParam("Search query (for filtering)")] public string search;
            [McpParam("Maximum results (default 50)")] public int maxResults;
        }

        [Serializable]
        public class TypeInfoEntry
        {
            public string name;
            public string category;
        }

        [Serializable]
        public class GetTypeInfoResult
        {
            public string category;
            public string search;
            public int count;
            public TypeInfoEntry[] types;
        }

        #endregion
    }
}
