using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
#if ENABLE_INPUT_SYSTEM
using System.Linq;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;
#endif

namespace Community.Unity.MCP
{
    /// <summary>
    /// MCP tools for simulating input during play mode.
    ///
    /// Primary path (Play Mode + com.unity.inputsystem present, i.e. ENABLE_INPUT_SYSTEM defined):
    /// injects raw device state into Keyboard.current / Mouse.current via
    /// InputSystem.QueueStateEvent. This reaches real game input - InputAction bindings,
    /// PlayerInput, Keyboard.current/Mouse.current polling, etc.
    ///
    /// Fallback path (not in Play Mode, or the Input System is unavailable at compile time):
    /// sends a legacy IMGUI Event to the focused EditorWindow, exactly like the original
    /// implementation. This never reaches game input - it only drives custom
    /// EditorWindow/IMGUI tooling.
    ///
    /// The response's "mode" field reports which path actually ran ("input-system" or
    /// "editor-event") so callers can tell whether Play-mode game input was really reached.
    /// </summary>
    [McpToolProvider]
    public class InputTools
    {
        [McpTool("unity_simulate_key", "Simulate a keyboard key during Play Mode via the Input System device state (reaches real game input: InputAction bindings, PlayerInput, Keyboard.current). Falls back to a legacy editor IMGUI key event (does NOT reach game input, only editor/IMGUI tooling) when not in Play Mode or when the Input System is unavailable.", typeof(SimulateKeyArgs))]
        public static object SimulateKey(string argsJson)
        {
            var args = JsonUtility.FromJson<SimulateKeyArgs>(argsJson);

            if (string.IsNullOrEmpty(args?.key))
            {
                return new McpToolError { error = "key parameter is required" };
            }

            string action = string.IsNullOrEmpty(args.action) ? "press" : args.action.ToLowerInvariant();
            if (action != "press" && action != "down" && action != "up")
            {
                return new McpToolError { error = $"Invalid action: {args.action}. Use 'press', 'down', or 'up'." };
            }

#if ENABLE_INPUT_SYSTEM
            if (EditorApplication.isPlaying)
            {
                if (!TryResolveKey(args.key, out var key, out var resolveError))
                {
                    return new McpToolError { error = resolveError };
                }

                SendKeyViaInputSystem(key, action);

                return new SimulateKeyResult
                {
                    success = true,
                    key = key.ToString(),
                    action = action,
                    mode = "input-system",
                    note = "Key state injected into Keyboard.current via InputSystem.QueueStateEvent. Reaches Play-mode game input."
                };
            }
#endif
            return SimulateKeyLegacy(args.key, action);
        }

        private static object SimulateKeyLegacy(string keyName, string action)
        {
            if (!Enum.TryParse<KeyCode>(keyName, true, out var keyCode))
            {
                return new McpToolError { error = $"Invalid key: {keyName}. Use a Unity KeyCode name like 'W', 'Space', 'LeftArrow', etc." };
            }

            var focusedWindow = EditorWindow.focusedWindow;
            if (focusedWindow != null)
            {
                var firstEventType = action == "up" ? EventType.KeyUp : EventType.KeyDown;
                focusedWindow.SendEvent(new Event { type = firstEventType, keyCode = keyCode });

                if (action == "press")
                {
                    focusedWindow.SendEvent(new Event { type = EventType.KeyUp, keyCode = keyCode });
                }
            }

            return new SimulateKeyResult
            {
                success = true,
                key = keyCode.ToString(),
                action = action,
                mode = "editor-event",
                note = "Not in Play Mode (or Input System unavailable): sent as an editor IMGUI event to the focused EditorWindow instead. This does not reach game input. Consider unity_execute_menu for editor actions or direct component calls for game logic."
            };
        }

        [McpTool("unity_simulate_mouse", "Simulate a mouse click/move during Play Mode via the Input System device state (reaches real game input). Falls back to a legacy editor IMGUI mouse event (does NOT reach game input, only editor/IMGUI tooling) when not in Play Mode or when the Input System is unavailable.", typeof(SimulateMouseArgs))]
        public static object SimulateMouse(string argsJson)
        {
            var args = JsonUtility.FromJson<SimulateMouseArgs>(argsJson);

            int button = args?.button ?? 0;
            float x = args?.x ?? 0;
            float y = args?.y ?? 0;
            string action = string.IsNullOrEmpty(args?.action) ? "click" : args.action.ToLowerInvariant();

            if (action != "click" && action != "down" && action != "up" && action != "move")
            {
                return new McpToolError { error = $"Invalid action: {args?.action}. Use 'click', 'down', 'up', or 'move'." };
            }

#if ENABLE_INPUT_SYSTEM
            if (EditorApplication.isPlaying)
            {
                MouseButton? mouseButton = null;
                if (action != "move")
                {
                    if (!TryResolveMouseButton(button, out var resolvedButton, out var buttonError))
                    {
                        return new McpToolError { error = buttonError };
                    }
                    mouseButton = resolvedButton;
                }

                // Legacy args used top-left-origin, y-down window coordinates (IMGUI Event.mousePosition
                // convention). The Input System's Mouse.position is bottom-left-origin, y-up screen
                // pixels. Flip Y against the current Game View resolution (Screen.height, which during
                // Play Mode in the editor reports the Game View's pixel size) so the same (x, y) still
                // refers to the same on-screen spot.
                var devicePosition = new Vector2(x, Screen.height - y);

                SendMouseViaInputSystem(mouseButton, devicePosition, action);

                return new SimulateMouseResult
                {
                    success = true,
                    button = button,
                    action = action,
                    x = x,
                    y = y,
                    mode = "input-system",
                    note = "Mouse state injected into Mouse.current via InputSystem.QueueStateEvent (x/y are top-left origin, y-down; converted internally to the Input System's bottom-left origin, y-up pixel space). Reaches Play-mode game input."
                };
            }
#endif
            return SimulateMouseLegacy(button, x, y, action);
        }

        private static object SimulateMouseLegacy(int button, float x, float y, string action)
        {
            EventType eventType;
            switch (action)
            {
                case "down":
                    eventType = EventType.MouseDown;
                    break;
                case "up":
                    eventType = EventType.MouseUp;
                    break;
                case "move":
                    eventType = EventType.MouseMove;
                    break;
                case "click":
                default:
                    eventType = EventType.MouseDown;
                    break;
            }

            var focusedWindow = EditorWindow.focusedWindow;
            if (focusedWindow != null)
            {
                focusedWindow.SendEvent(new Event { type = eventType, button = button, mousePosition = new Vector2(x, y) });

                if (action == "click")
                {
                    focusedWindow.SendEvent(new Event { type = EventType.MouseUp, button = button, mousePosition = new Vector2(x, y) });
                }
            }

            return new SimulateMouseResult
            {
                success = true,
                button = button,
                action = action,
                x = x,
                y = y,
                mode = "editor-event",
                note = "Not in Play Mode (or Input System unavailable): sent as an editor IMGUI event to the focused EditorWindow instead (x/y are window-local, top-left origin). This does not reach game input. For UI testing, consider unity_click_ui_element instead."
            };
        }

        [McpTool("unity_click_ui_element", "Click a UI element by name during play mode", typeof(ClickUIElementArgs))]
        public static object ClickUIElement(string argsJson)
        {
            var args = JsonUtility.FromJson<ClickUIElementArgs>(argsJson);

            if (!EditorApplication.isPlaying)
            {
                return new McpToolError { error = "UI interaction only works during play mode" };
            }

            if (string.IsNullOrEmpty(args?.objectName))
            {
                return new McpToolError { error = "objectName parameter is required" };
            }

            // Find the GameObject
            var go = GameObject.Find(args.objectName);
            if (go == null)
            {
                return new McpToolError { error = $"GameObject not found: {args.objectName}" };
            }

            // Try to find and invoke Button component
            var button = go.GetComponent<UnityEngine.UI.Button>();
            if (button != null)
            {
                button.onClick.Invoke();
                return new ClickUIElementResult
                {
                    success = true,
                    objectName = args.objectName,
                    componentType = "Button",
                    message = "Button click invoked"
                };
            }

            // Try Toggle
            var toggle = go.GetComponent<UnityEngine.UI.Toggle>();
            if (toggle != null)
            {
                toggle.isOn = !toggle.isOn;
                return new ClickUIElementResult
                {
                    success = true,
                    objectName = args.objectName,
                    componentType = "Toggle",
                    message = $"Toggle set to {toggle.isOn}"
                };
            }

            return new McpToolError { error = $"No clickable UI component found on: {args.objectName}" };
        }

#if ENABLE_INPUT_SYSTEM
        #region Input System injection (Play Mode)

        // Keys/buttons currently simulated as "held", tracked across calls so a sequence like
        // simulate_key(W, down) -> simulate_key(Space, press) -> simulate_key(W, up) keeps W held
        // while Space is tapped, instead of each call clobbering the rest of the device state.
        // NOTE: static fields reset on a domain reload (e.g. re-entering Play Mode with "Reload
        // Domain" enabled, which is the Unity default) - held keys/buttons will not survive that.
        private static readonly HashSet<Key> s_HeldKeys = new HashSet<Key>();
        private static readonly HashSet<MouseButton> s_HeldMouseButtons = new HashSet<MouseButton>();
        private static Vector2 s_MousePosition;

        // Unity's legacy KeyCode enum names some keys differently than the Input System's Key
        // enum. Keys with identical names (letters, arrows, F1-F12, Escape, Space, ...) resolve
        // directly via Enum.TryParse<Key> and need no entry here - this only covers the subset
        // where the historical unity_simulate_key "key" argument used a different word.
        private static readonly Dictionary<string, Key> s_LegacyKeyCodeToKey = new Dictionary<string, Key>(StringComparer.OrdinalIgnoreCase)
        {
            { "Alpha0", Key.Digit0 }, { "Alpha1", Key.Digit1 }, { "Alpha2", Key.Digit2 },
            { "Alpha3", Key.Digit3 }, { "Alpha4", Key.Digit4 }, { "Alpha5", Key.Digit5 },
            { "Alpha6", Key.Digit6 }, { "Alpha7", Key.Digit7 }, { "Alpha8", Key.Digit8 },
            { "Alpha9", Key.Digit9 },
            { "Keypad0", Key.Numpad0 }, { "Keypad1", Key.Numpad1 }, { "Keypad2", Key.Numpad2 },
            { "Keypad3", Key.Numpad3 }, { "Keypad4", Key.Numpad4 }, { "Keypad5", Key.Numpad5 },
            { "Keypad6", Key.Numpad6 }, { "Keypad7", Key.Numpad7 }, { "Keypad8", Key.Numpad8 },
            { "Keypad9", Key.Numpad9 },
            { "KeypadPeriod", Key.NumpadPeriod }, { "KeypadDivide", Key.NumpadDivide },
            { "KeypadMultiply", Key.NumpadMultiply }, { "KeypadMinus", Key.NumpadMinus },
            { "KeypadPlus", Key.NumpadPlus }, { "KeypadEnter", Key.NumpadEnter },
            { "KeypadEquals", Key.NumpadEquals },
            { "Return", Key.Enter },
            { "LeftControl", Key.LeftCtrl }, { "RightControl", Key.RightCtrl },
            { "Print", Key.PrintScreen },
            { "LeftCommand", Key.LeftMeta }, { "LeftWindows", Key.LeftMeta }, { "LeftApple", Key.LeftMeta },
            { "RightCommand", Key.RightMeta }, { "RightWindows", Key.RightMeta }, { "RightApple", Key.RightMeta },
        };

        /// <summary>
        /// Resolves a key name to an Input System <see cref="Key"/>. Accepts native Key enum
        /// names ("Enter", "Digit1", "LeftArrow", "LeftCtrl", ...) as well as every legacy Unity
        /// KeyCode name unity_simulate_key historically accepted ("Return", "Alpha1", "W", ...).
        /// </summary>
        private static bool TryResolveKey(string name, out Key key, out string error)
        {
            error = null;

            // 1) Native Input System Key name (also covers every KeyCode name that happens to be
            //    spelled identically in both enums, e.g. letters, arrows, F1-F12, Escape, Space).
            if (Enum.TryParse<Key>(name, true, out key))
                return true;

            // 2) Legacy KeyCode name that is spelled differently in the Key enum.
            if (s_LegacyKeyCodeToKey.TryGetValue(name, out key))
                return true;

            if (Enum.TryParse<KeyCode>(name, true, out var keyCode))
            {
                error = $"Key '{name}' (KeyCode.{keyCode}) has no keyboard equivalent in the Input System (e.g. it is a mouse/joystick code). Use a keyboard key name.";
            }
            else
            {
                error = $"Invalid key: {name}. Use an Input System Key name (e.g. 'Enter', 'Digit1', 'LeftArrow') or a legacy Unity KeyCode name (e.g. 'Return', 'Alpha1', 'W').";
            }

            key = default;
            return false;
        }

        private static bool TryResolveMouseButton(int button, out MouseButton mouseButton, out string error)
        {
            error = null;
            switch (button)
            {
                case 0:
                    mouseButton = MouseButton.Left;
                    return true;
                case 1:
                    mouseButton = MouseButton.Right;
                    return true;
                case 2:
                    mouseButton = MouseButton.Middle;
                    return true;
                default:
                    mouseButton = default;
                    error = $"Invalid button: {button}. Use 0=left, 1=right, 2=middle.";
                    return false;
            }
        }

        private static void SendKeyViaInputSystem(Key key, string action)
        {
            var keyboard = Keyboard.current ?? InputSystem.AddDevice<Keyboard>();

            switch (action)
            {
                case "down":
                    s_HeldKeys.Add(key);
                    QueueKeyboardState(keyboard);
                    break;
                case "up":
                    s_HeldKeys.Remove(key);
                    QueueKeyboardState(keyboard);
                    break;
                case "press":
                default:
                    s_HeldKeys.Add(key);
                    QueueKeyboardState(keyboard);
                    s_HeldKeys.Remove(key);
                    QueueKeyboardState(keyboard);
                    break;
            }
        }

        private static void QueueKeyboardState(Keyboard keyboard)
        {
            InputSystem.QueueStateEvent(keyboard, new KeyboardState(s_HeldKeys.ToArray()));
            InputSystem.Update();
        }

        private static void SendMouseViaInputSystem(MouseButton? button, Vector2 devicePosition, string action)
        {
            var mouse = Mouse.current ?? InputSystem.AddDevice<Mouse>();
            s_MousePosition = devicePosition;

            switch (action)
            {
                case "move":
                    QueueMouseState(mouse);
                    break;
                case "down":
                    if (button.HasValue) s_HeldMouseButtons.Add(button.Value);
                    QueueMouseState(mouse);
                    break;
                case "up":
                    if (button.HasValue) s_HeldMouseButtons.Remove(button.Value);
                    QueueMouseState(mouse);
                    break;
                case "click":
                default:
                    if (button.HasValue) s_HeldMouseButtons.Add(button.Value);
                    QueueMouseState(mouse);
                    if (button.HasValue) s_HeldMouseButtons.Remove(button.Value);
                    QueueMouseState(mouse);
                    break;
            }
        }

        private static void QueueMouseState(Mouse mouse)
        {
            var state = new MouseState { position = s_MousePosition };
            foreach (var heldButton in s_HeldMouseButtons)
                state = state.WithButton(heldButton);

            InputSystem.QueueStateEvent(mouse, state);
            InputSystem.Update();
        }

        #endregion
#endif

        #region Data Types

        [Serializable]
        public class SimulateKeyArgs
        {
            [McpParam("Key name. Accepts Input System Key names ('Enter', 'Digit1', 'LeftArrow', 'LeftCtrl') or legacy Unity KeyCode names ('Return', 'Alpha1', 'W', 'Space', 'Escape').", Required = true)] public string key;
            [McpParam("Action type", EnumValues = new[] { "press", "down", "up" })] public string action;
        }

        [Serializable]
        public class SimulateKeyResult
        {
            public bool success;
            public string key;
            public string action;
            public string mode;
            public string note;
        }

        [Serializable]
        public class SimulateMouseArgs
        {
            [McpParam("X position in pixels, top-left origin (legacy convention; auto-converted to the Input System's coordinate space)")] public float x;
            [McpParam("Y position in pixels, top-left origin, y-down (legacy convention; auto-converted to the Input System's bottom-left origin, y-up coordinate space)")] public float y;
            [McpParam("Mouse button (0=left, 1=right, 2=middle)")] public int button;
            [McpParam("Action type", EnumValues = new[] { "click", "down", "up", "move" })] public string action;
        }

        [Serializable]
        public class SimulateMouseResult
        {
            public bool success;
            public int button;
            public string action;
            public float x;
            public float y;
            public string mode;
            public string note;
        }

        [Serializable]
        public class ClickUIElementArgs
        {
            [McpParam("Name of the GameObject with UI component", Required = true)] public string objectName;
        }

        [Serializable]
        public class ClickUIElementResult
        {
            public bool success;
            public string objectName;
            public string componentType;
            public string message;
        }

        #endregion
    }
}
