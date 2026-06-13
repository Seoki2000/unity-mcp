using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;

namespace Community.Unity.MCP
{
    /// <summary>
    /// MCP tools for accessing compilation status and errors.
    /// [OPTIMIZED] Warning 상세 정보는 반환하지 않고 개수만 반환하여 응답 크기 대폭 축소.
    /// </summary>
    [McpToolProvider]
    public class CompilationTools
    {
        private static readonly List<CompilationError> _compilationErrors = new List<CompilationError>();
        private static int _warningCount;
        private static bool _isInitialized;

        static CompilationTools()
        {
            Initialize();
        }

        private static void Initialize()
        {
            if (_isInitialized) return;
            
            CompilationPipeline.compilationStarted += OnCompilationStarted;
            CompilationPipeline.compilationFinished += OnCompilationFinished;
            CompilationPipeline.assemblyCompilationFinished += OnAssemblyCompilationFinished;
            
            _isInitialized = true;
        }

        private static void OnCompilationStarted(object context)
        {
            lock (_compilationErrors)
            {
                _compilationErrors.Clear();
                _warningCount = 0;
            }
        }

        private static void OnCompilationFinished(object context)
        {
            // Compilation finished - errors are already captured
        }

        private static void OnAssemblyCompilationFinished(string assemblyPath, CompilerMessage[] messages)
        {
            lock (_compilationErrors)
            {
                foreach (var message in messages)
                {
                    if (message.type == CompilerMessageType.Error)
                    {
                        // [OPTIMIZED] 에러만 상세 정보 저장
                        _compilationErrors.Add(new CompilationError
                        {
                            message = message.message,
                            file = message.file,
                            line = message.line
                        });
                    }
                    else if (message.type == CompilerMessageType.Warning)
                    {
                        // [OPTIMIZED] 경고는 개수만 카운트 (상세 정보 저장 안 함)
                        _warningCount++;
                    }
                }
            }
        }

        [McpTool("unity_get_compilation_status", "Get the current compilation status and any errors")]
        public static object GetCompilationStatus(string argsJson)
        {
            Initialize();
            
            List<CompilationError> errors;
            int warningCount;
            lock (_compilationErrors)
            {
                errors = new List<CompilationError>(_compilationErrors);
                warningCount = _warningCount;
            }
            
            return new CompilationStatusResult
            {
                isCompiling = EditorApplication.isCompiling,
                hasErrors = errors.Count > 0,
                errorCount = errors.Count,
                warningCount = warningCount,
                errors = errors.Count > 0 ? errors.ToArray() : null
                // [OPTIMIZED] warnings 배열 완전 제거, 개수만 반환
            };
        }

        [McpTool("unity_recompile_scripts", "Force recompilation of all scripts")]
        public static object RecompileScripts(string argsJson)
        {
            if (EditorApplication.isCompiling)
            {
                return new { error = "Compilation is already in progress" };
            }
            
            CompilationPipeline.RequestScriptCompilation();
            
            return new RecompileResult
            {
                success = true,
                message = "Script recompilation requested"
            };
        }

        [McpTool("unity_get_assemblies", "Get information about project assemblies")]
        public static object GetAssemblies(string argsJson)
        {
            var assemblies = CompilationPipeline.GetAssemblies(AssembliesType.Player);
            var assemblyInfos = new List<AssemblyInfo>();
            
            foreach (var asm in assemblies)
            {
                assemblyInfos.Add(new AssemblyInfo
                {
                    name = asm.name,
                    sourceFileCount = asm.sourceFiles.Length
                    // [OPTIMIZED] outputPath, sourceFiles[], flags 제거
                });
            }
            
            return new GetAssembliesResult
            {
                assemblyCount = assemblyInfos.Count,
                assemblies = assemblyInfos.ToArray()
            };
        }

        #region Data Types

        [Serializable]
        public class CompilationError
        {
            // [OPTIMIZED] type, column, assemblyPath 제거
            public string message;
            public string file;
            public int line;
        }

        [Serializable]
        public class CompilationStatusResult
        {
            public bool isCompiling;
            public bool hasErrors;
            public int errorCount;
            public int warningCount;
            public CompilationError[] errors;
            // [OPTIMIZED] warnings 배열 제거
        }

        [Serializable]
        public class RecompileResult
        {
            public bool success;
            public string message;
        }

        [Serializable]
        public class AssemblyInfo
        {
            public string name;
            // [OPTIMIZED] outputPath, flags 제거
            public int sourceFileCount;
            // [OPTIMIZED] sourceFiles[] 제거
        }

        [Serializable]
        public class GetAssembliesResult
        {
            public int assemblyCount;
            public AssemblyInfo[] assemblies;
        }

        #endregion
    }
}
