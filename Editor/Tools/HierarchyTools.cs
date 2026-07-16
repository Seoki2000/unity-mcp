using System;
using System.Collections.Generic;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Community.Unity.MCP
{
    /// <summary>
    /// MCP tools for querying Unity scene hierarchy.
    /// [OPTIMIZED] Reduced response sizes for token efficiency with AI coding assistants.
    /// </summary>
    [McpToolProvider]
    public class HierarchyTools
    {
        // [OPTIMIZED] 기존 maxDepth 3 -> 2로 축소, 자식이 너무 많으면 잘라냄
        private const int DEFAULT_MAX_DEPTH = 2;
        private const int MAX_CHILDREN_PER_NODE = 20;
        // [OPTIMIZED] 루트가 평평하게 수백 개인 씬(환경 에셋팩 등) 대응:
        // 루트 오브젝트 수 상한 + 전체 노드 예산으로 응답 폭주 차단.
        private const int MAX_ROOT_OBJECTS = 50;
        private const int MAX_TOTAL_NODES = 300;

        [McpTool("unity_get_hierarchy", "Get the hierarchy of GameObjects in the current scene")]
        public static object GetHierarchy(string argsJson)
        {
            var scene = SceneManager.GetActiveScene();
            var rootObjects = scene.GetRootGameObjects();
            var hierarchy = new List<GameObjectInfo>();

            int nodeBudget = MAX_TOTAL_NODES;
            int rootLimit = Mathf.Min(rootObjects.Length, MAX_ROOT_OBJECTS);
            for (int i = 0; i < rootLimit && nodeBudget > 0; i++)
            {
                hierarchy.Add(BuildHierarchy(rootObjects[i], 0, DEFAULT_MAX_DEPTH, ref nodeBudget));
            }

            return new HierarchyResult
            {
                sceneName = scene.name,
                rootObjectCount = rootObjects.Length,
                returnedRootCount = hierarchy.Count,
                // 루트가 잘렸거나 노드 예산이 소진되면 truncated 표시
                truncated = rootObjects.Length > hierarchy.Count || nodeBudget <= 0,
                rootObjects = hierarchy.ToArray()
            };
        }

        [McpTool("unity_get_gameobject", "Get details of a specific GameObject by path", typeof(GetGameObjectArgs))]
        public static object GetGameObject(string argsJson)
        {
            var args = JsonUtility.FromJson<GetGameObjectArgs>(argsJson);
            
            if (string.IsNullOrEmpty(args?.path))
            {
                return new { error = "path parameter is required" };
            }

            var go = GameObject.Find(args.path);
            if (go == null)
            {
                return new { error = $"GameObject not found: {args.path}" };
            }

            return BuildDetailedGameObjectInfo(go);
        }

        [McpTool("unity_get_components", "Get all components on a GameObject", typeof(GetGameObjectArgs))]
        public static object GetComponents(string argsJson)
        {
            var args = JsonUtility.FromJson<GetGameObjectArgs>(argsJson);
            
            if (string.IsNullOrEmpty(args?.path))
            {
                return new { error = "path parameter is required" };
            }

            var go = GameObject.Find(args.path);
            if (go == null)
            {
                return new { error = $"GameObject not found: {args.path}" };
            }

            var components = go.GetComponents<Component>();
            var componentInfos = new List<ComponentInfo>();

            foreach (var comp in components)
            {
                if (comp == null) continue;
                
                componentInfos.Add(new ComponentInfo
                {
                    typeName = comp.GetType().Name,
                    enabled = comp is Behaviour b ? b.enabled : true
                });
            }

            return new ComponentsResult
            {
                gameObjectPath = args.path,
                components = componentInfos.ToArray()
            };
        }

        private static GameObjectInfo BuildHierarchy(GameObject go, int depth, int maxDepth, ref int nodeBudget)
        {
            nodeBudget--; // 이 노드 소비

            var info = new GameObjectInfo
            {
                name = go.name,
                active = go.activeSelf,
                childCount = go.transform.childCount,
                componentCount = go.GetComponents<Component>().Length
            };

            if (depth < maxDepth && go.transform.childCount > 0 && nodeBudget > 0)
            {
                var children = new List<GameObjectInfo>();
                int childLimit = Mathf.Min(go.transform.childCount, MAX_CHILDREN_PER_NODE);

                for (int i = 0; i < childLimit && nodeBudget > 0; i++)
                {
                    children.Add(BuildHierarchy(go.transform.GetChild(i).gameObject, depth + 1, maxDepth, ref nodeBudget));
                }

                info.children = children.ToArray();

                // 자식 상한 또는 노드 예산으로 잘렸으면 표시
                if (go.transform.childCount > children.Count)
                {
                    info.truncated = true;
                }
            }

            return info;
        }

        private static object BuildDetailedGameObjectInfo(GameObject go)
        {
            var components = go.GetComponents<Component>();
            var componentNames = new List<string>();
            foreach (var c in components)
            {
                if (c != null) componentNames.Add(c.GetType().Name);
            }

            return new DetailedGameObjectInfo
            {
                name = go.name,
                path = GetGameObjectPath(go),
                active = go.activeSelf,
                isStatic = go.isStatic,
                tag = go.tag != "Untagged" ? go.tag : null, // Untagged는 생략
                layer = go.layer != 0 ? LayerMask.LayerToName(go.layer) : null, // Default 레이어는 생략
                position = FormatVector3(go.transform.position),
                rotation = FormatVector3(go.transform.rotation.eulerAngles),
                scale = FormatVector3(go.transform.localScale),
                childCount = go.transform.childCount,
                components = componentNames.ToArray()
            };
        }

        // [OPTIMIZED] Vector3를 소수점 2자리로 반올림하여 문자열 크기 축소
        private static string FormatVector3(Vector3 v)
        {
            return $"({v.x:F2},{v.y:F2},{v.z:F2})";
        }

        private static string GetGameObjectPath(GameObject go)
        {
            var path = new StringBuilder(go.name);
            var parent = go.transform.parent;
            while (parent != null)
            {
                path.Insert(0, parent.name + "/");
                parent = parent.parent;
            }
            return path.ToString();
        }

        #region Data Types

        [Serializable]
        public class GetGameObjectArgs
        {
            [McpParam("Path to the GameObject", Required = true)] public string path;
        }

        [Serializable]
        public class HierarchyResult
        {
            public string sceneName;
            public int rootObjectCount;
            public int returnedRootCount;
            public bool truncated;
            public GameObjectInfo[] rootObjects;
        }

        [Serializable]
        public class GameObjectInfo
        {
            public string name;
            public bool active;
            // [OPTIMIZED] tag, layer 제거 (대부분 Untagged/Default라 무의미한 토큰 소비)
            public int childCount;
            public int componentCount;
            public bool truncated; // 자식이 잘렸는지 여부
            public GameObjectInfo[] children;
        }

        [Serializable]
        public class DetailedGameObjectInfo
        {
            public string name;
            public string path;
            public bool active;
            public bool isStatic;
            public string tag;    // Untagged가 아닐 때만 포함
            public string layer;  // Default가 아닐 때만 포함
            public string position;
            public string rotation;
            public string scale;
            public int childCount;
            public string[] components;
        }

        [Serializable]
        public class ComponentsResult
        {
            public string gameObjectPath;
            public ComponentInfo[] components;
        }

        [Serializable]
        public class ComponentInfo
        {
            public string typeName;
            // [OPTIMIZED] fullTypeName 제거 - typeName만으로 충분
            public bool enabled;
        }

        #endregion
    }
}
