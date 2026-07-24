using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace Community.Unity.MCP
{
    /// <summary>
    /// MCP tools for controlling animations and animators.
    /// </summary>
    [McpToolProvider]
    public class AnimationTools
    {
        [McpTool("unity_get_animator_controller_info", "Get the static graph structure (states, transitions, default states) of an Animator Controller", typeof(GetAnimatorControllerInfoArgs))]
        public static object GetAnimatorControllerInfo(string argsJson)
        {
            var args = JsonUtility.FromJson<GetAnimatorControllerInfoArgs>(argsJson);
            
            UnityEditor.Animations.AnimatorController controller = null;

            if (!string.IsNullOrEmpty(args?.assetPath))
            {
                controller = AssetDatabase.LoadAssetAtPath<UnityEditor.Animations.AnimatorController>(args.assetPath);
                if (controller == null)
                    return new McpToolError { error = $"AnimatorController not found at path: {args.assetPath}" };
            }
            else if (!string.IsNullOrEmpty(args?.path))
            {
                var go = GameObject.Find(args.path);
                if (go == null)
                    return new McpToolError { error = $"GameObject not found: {args.path}" };
                
                var animator = go.GetComponent<Animator>();
                if (animator == null)
                    return new McpToolError { error = $"No Animator component on: {args.path}" };
                
                controller = animator.runtimeAnimatorController as UnityEditor.Animations.AnimatorController;
                if (controller == null)
                {
                    // If it's an override controller, try to get the base
                    var overrideController = animator.runtimeAnimatorController as AnimatorOverrideController;
                    if (overrideController != null)
                    {
                        controller = overrideController.runtimeAnimatorController as UnityEditor.Animations.AnimatorController;
                    }
                }
                
                if (controller == null)
                    return new McpToolError { error = $"No valid AnimatorController found on Animator: {args.path}" };
            }
            else
            {
                return new McpToolError { error = "Either path (GameObject) or assetPath (AnimatorController asset) is required" };
            }

            var result = new GetAnimatorControllerInfoResult
            {
                name = controller.name,
                assetPath = AssetDatabase.GetAssetPath(controller),
                parameters = new List<ControllerParameterInfo>(),
                layers = new List<ControllerLayerInfo>()
            };

            // Get parameters
            foreach (var param in controller.parameters)
            {
                result.parameters.Add(new ControllerParameterInfo
                {
                    name = param.name,
                    type = param.type.ToString(),
                    defaultFloat = param.defaultFloat,
                    defaultInt = param.defaultInt,
                    defaultBool = param.defaultBool
                });
            }

            // Get layers and states
            foreach (var layer in controller.layers)
            {
                var layerInfo = new ControllerLayerInfo
                {
                    name = layer.name,
                    defaultWeight = layer.defaultWeight,
                    states = new List<ControllerStateInfo>(),
                    anyStateTransitions = new List<ControllerTransitionInfo>()
                };

                var stateMachine = layer.stateMachine;
                if (stateMachine.defaultState != null)
                {
                    layerInfo.defaultState = stateMachine.defaultState.name;
                }

                // AnyState Transitions
                foreach (var trans in stateMachine.anyStateTransitions)
                {
                    layerInfo.anyStateTransitions.Add(GetTransitionInfo("AnyState", trans));
                }

                // States
                foreach (var childState in stateMachine.states)
                {
                    var state = childState.state;
                    var stateInfo = new ControllerStateInfo
                    {
                        name = state.name,
                        tag = state.tag,
                        speed = state.speed,
                        motion = state.motion != null ? state.motion.name : "None",
                        transitions = new List<ControllerTransitionInfo>()
                    };

                    foreach (var trans in state.transitions)
                    {
                        stateInfo.transitions.Add(GetTransitionInfo(state.name, trans));
                    }

                    layerInfo.states.Add(stateInfo);
                }

                result.layers.Add(layerInfo);
            }

            return result;
        }

        private static ControllerTransitionInfo GetTransitionInfo(string sourceName, UnityEditor.Animations.AnimatorStateTransition transition)
        {
            var info = new ControllerTransitionInfo
            {
                source = sourceName,
                destination = transition.isExit ? "Exit" : (transition.destinationState != null ? transition.destinationState.name : "Unknown"),
                hasExitTime = transition.hasExitTime,
                conditions = new List<string>()
            };

            foreach (var cond in transition.conditions)
            {
                info.conditions.Add($"{cond.parameter} {cond.mode} {cond.threshold}");
            }
            return info;
        }

        [McpTool("unity_set_animator_parameter", "Set a parameter on an Animator component", typeof(SetAnimatorParameterArgs))]
        public static object SetAnimatorParameter(string argsJson)
        {
            var args = JsonUtility.FromJson<SetAnimatorParameterArgs>(argsJson);
            
            if (string.IsNullOrEmpty(args?.path))
                return new McpToolError { error = "path parameter is required" };
            if (string.IsNullOrEmpty(args?.parameterName))
                return new McpToolError { error = "parameterName parameter is required" };
            
            var go = GameObject.Find(args.path);
            if (go == null)
                return new McpToolError { error = $"GameObject not found: {args.path}" };
            
            var animator = go.GetComponent<Animator>();
            if (animator == null)
                return new McpToolError { error = $"No Animator component on: {args.path}" };
            
            string paramType = string.IsNullOrEmpty(args.parameterType) ? "trigger" : args.parameterType.ToLower();
            
            try
            {
                switch (paramType)
                {
                    case "bool":
                        animator.SetBool(args.parameterName, args.boolValue);
                        break;
                    case "int":
                    case "integer":
                        animator.SetInteger(args.parameterName, args.intValue);
                        break;
                    case "float":
                        animator.SetFloat(args.parameterName, args.floatValue);
                        break;
                    case "trigger":
                        animator.SetTrigger(args.parameterName);
                        break;
                    default:
                        return new McpToolError { error = $"Unknown parameter type: {paramType}. Use: bool, int, float, trigger" };
                }
                
                return new SetAnimatorParameterResult
                {
                    success = true,
                    path = args.path,
                    parameterName = args.parameterName,
                    parameterType = paramType
                };
            }
            catch (Exception ex)
            {
                return new McpToolError { error = $"Failed to set parameter: {ex.Message}" };
            }
        }

        [McpTool("unity_get_animator_info", "Get information about an Animator component", typeof(GetAnimatorInfoArgs))]
        public static object GetAnimatorInfo(string argsJson)
        {
            var args = JsonUtility.FromJson<GetAnimatorInfoArgs>(argsJson);
            
            if (string.IsNullOrEmpty(args?.path))
                return new McpToolError { error = "path parameter is required" };
            
            var go = GameObject.Find(args.path);
            if (go == null)
                return new McpToolError { error = $"GameObject not found: {args.path}" };
            
            var animator = go.GetComponent<Animator>();
            if (animator == null)
                return new McpToolError { error = $"No Animator component on: {args.path}" };
            
            // Get parameters
            var parameters = new List<AnimatorParameterInfo>();
            foreach (var param in animator.parameters)
            {
                var paramInfo = new AnimatorParameterInfo
                {
                    name = param.name,
                    type = param.type.ToString()
                };
                
                switch (param.type)
                {
                    case AnimatorControllerParameterType.Bool:
                        paramInfo.currentValue = animator.GetBool(param.name).ToString();
                        break;
                    case AnimatorControllerParameterType.Int:
                        paramInfo.currentValue = animator.GetInteger(param.name).ToString();
                        break;
                    case AnimatorControllerParameterType.Float:
                        paramInfo.currentValue = animator.GetFloat(param.name).ToString("F2");
                        break;
                    case AnimatorControllerParameterType.Trigger:
                        paramInfo.currentValue = "trigger";
                        break;
                }
                
                parameters.Add(paramInfo);
            }
            
            // Get layer info
            var layers = new List<AnimatorLayerInfo>();
            for (int i = 0; i < animator.layerCount; i++)
            {
                var stateInfo = animator.GetCurrentAnimatorStateInfo(i);
                layers.Add(new AnimatorLayerInfo
                {
                    index = i,
                    name = animator.GetLayerName(i),
                    weight = animator.GetLayerWeight(i),
                    currentStateHash = stateInfo.fullPathHash,
                    normalizedTime = stateInfo.normalizedTime,
                    isInTransition = animator.IsInTransition(i)
                });
            }
            
            return new GetAnimatorInfoResult
            {
                path = args.path,
                hasController = animator.runtimeAnimatorController != null,
                controllerName = animator.runtimeAnimatorController?.name ?? "None",
                isPlaying = animator.enabled && Application.isPlaying,
                speed = animator.speed,
                parameters = parameters.ToArray(),
                layers = layers.ToArray()
            };
        }

        [McpTool("unity_play_animation", "Play an animation state on an Animator", typeof(PlayAnimationArgs))]
        public static object PlayAnimation(string argsJson)
        {
            var args = JsonUtility.FromJson<PlayAnimationArgs>(argsJson);
            
            if (string.IsNullOrEmpty(args?.path))
                return new McpToolError { error = "path parameter is required" };
            if (string.IsNullOrEmpty(args?.stateName))
                return new McpToolError { error = "stateName parameter is required" };
            
            var go = GameObject.Find(args.path);
            if (go == null)
                return new McpToolError { error = $"GameObject not found: {args.path}" };
            
            var animator = go.GetComponent<Animator>();
            if (animator == null)
                return new McpToolError { error = $"No Animator component on: {args.path}" };
            
            int layer = args.layer >= 0 ? args.layer : 0;
            float normalizedTime = args.normalizedTime >= 0 ? args.normalizedTime : 0f;
            
            try
            {
                animator.Play(args.stateName, layer, normalizedTime);
                
                return new PlayAnimationResult
                {
                    success = true,
                    path = args.path,
                    stateName = args.stateName,
                    layer = layer,
                    note = EditorApplication.isPlaying ? "Animation playing" : "Animation set (enter Play Mode to see)"
                };
            }
            catch (Exception ex)
            {
                return new McpToolError { error = $"Failed to play animation: {ex.Message}" };
            }
        }

        #region Data Types

        [Serializable]
        public class SetAnimatorParameterArgs
        {
            [McpParam("Path to the GameObject", Required = true)] public string path;
            [McpParam("Parameter name", Required = true)] public string parameterName;
            [McpParam("Parameter type", EnumValues = new[] { "bool", "int", "float", "trigger" })] public string parameterType;
            [McpParam("Bool value (for bool type)")] public bool boolValue;
            [McpParam("Int value (for int type)")] public int intValue;
            [McpParam("Float value (for float type)")] public float floatValue;
        }

        [Serializable]
        public class SetAnimatorParameterResult
        {
            public bool success;
            public string path;
            public string parameterName;
            public string parameterType;
        }

        [Serializable]
        public class GetAnimatorInfoArgs
        {
            [McpParam("Path to the GameObject", Required = true)] public string path;
        }

        [Serializable]
        public class AnimatorParameterInfo
        {
            public string name;
            public string type;
            public string currentValue;
        }

        [Serializable]
        public class AnimatorLayerInfo
        {
            public int index;
            public string name;
            public float weight;
            public int currentStateHash;
            public float normalizedTime;
            public bool isInTransition;
        }

        [Serializable]
        public class GetAnimatorInfoResult
        {
            public string path;
            public bool hasController;
            public string controllerName;
            public bool isPlaying;
            public float speed;
            public AnimatorParameterInfo[] parameters;
            public AnimatorLayerInfo[] layers;
        }

        [Serializable]
        public class PlayAnimationArgs
        {
            [McpParam("Path to the GameObject", Required = true)] public string path;
            [McpParam("Animation state name", Required = true)] public string stateName;
            [McpParam("Layer index (default 0)")] public int layer;
            [McpParam("Normalized time to start from (0-1)")] public float normalizedTime;
        }

        [Serializable]
        public class PlayAnimationResult
        {
            public bool success;
            public string path;
            public string stateName;
            public int layer;
            public string note;
        }

        [Serializable]
        public class GetAnimatorControllerInfoArgs
        {
            [McpParam("Path to the GameObject (optional if assetPath is provided)")] public string path;
            [McpParam("Asset path of the Animator Controller (optional if path is provided)")] public string assetPath;
        }

        [Serializable]
        public class ControllerParameterInfo
        {
            public string name;
            public string type;
            public float defaultFloat;
            public int defaultInt;
            public bool defaultBool;
        }

        [Serializable]
        public class ControllerTransitionInfo
        {
            public string source;
            public string destination;
            public bool hasExitTime;
            public List<string> conditions;
        }

        [Serializable]
        public class ControllerStateInfo
        {
            public string name;
            public string tag;
            public float speed;
            public string motion;
            public List<ControllerTransitionInfo> transitions;
        }

        [Serializable]
        public class ControllerLayerInfo
        {
            public string name;
            public float defaultWeight;
            public string defaultState;
            public List<ControllerStateInfo> states;
            public List<ControllerTransitionInfo> anyStateTransitions;
        }

        [Serializable]
        public class GetAnimatorControllerInfoResult
        {
            public string name;
            public string assetPath;
            public List<ControllerParameterInfo> parameters;
            public List<ControllerLayerInfo> layers;
        }

        #endregion
    }
}
