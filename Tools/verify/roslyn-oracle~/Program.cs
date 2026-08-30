using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

if (args.Length != 2) throw new ArgumentException("usage: analyzer <project-root> <output-json>");
var rootPath = Path.GetFullPath(args[0]);
var outputPath = Path.GetFullPath(args[1]);
var definesByFile = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase);
foreach (var projectFile in Directory.EnumerateFiles(rootPath, "*.csproj", SearchOption.TopDirectoryOnly))
{
    try
    {
        var doc = XDocument.Load(projectFile);
        var defines = doc.Descendants().FirstOrDefault(x => x.Name.LocalName == "DefineConstants")?.Value
            .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries) ?? Array.Empty<string>();
        foreach (var compile in doc.Descendants().Where(x => x.Name.LocalName == "Compile"))
        {
            var include = compile.Attributes().FirstOrDefault(x => x.Name.LocalName == "Include")?.Value;
            if (!string.IsNullOrWhiteSpace(include))
                definesByFile[Path.GetFullPath(Path.Combine(rootPath, include))] = defines;
        }
    }
    catch { }
}
var typeDecls = new List<object>();
var fields = new List<object>();
var loads = new List<object>();
var triviaLoads = new List<object>();
var disabledRanges = new List<object>();
var files = new List<object>();
var rawLoad = new Regex(@"(?:Resources\s*\.\s*Load(?:All|Async)?|AssetDatabase\s*\.\s*Load(?:AssetAtPath|MainAssetAtPath|AllAssetsAtPath|AllAssetRepresentationsAtPath))\s*(?:<[^>()]*>)?\s*\(", RegexOptions.Compiled);

string Rel(string p) => Path.GetRelativePath(rootPath, p).Replace('\\', '/');
string NamespaceOf(SyntaxNode node) => string.Join(".", node.Ancestors()
    .OfType<BaseNamespaceDeclarationSyntax>().Reverse().Select(n => n.Name.ToString()));
string NestedName(BaseTypeDeclarationSyntax node) => string.Join("/", node.Ancestors()
    .OfType<BaseTypeDeclarationSyntax>().Reverse().Select(t => t.Identifier.ValueText)
    .Append(node.Identifier.ValueText));

foreach (var abs in Directory.EnumerateFiles(Path.Combine(rootPath, "Assets"), "*.cs", SearchOption.AllDirectories))
{
    string text;
    try { text = File.ReadAllText(abs); } catch { continue; }
    var rel = Rel(abs);
    var defines = definesByFile.TryGetValue(Path.GetFullPath(abs), out var configured)
        ? configured : new[] { "UNITY_EDITOR", "UNITY_STANDALONE_WIN", "ENABLE_INPUT_SYSTEM" };
    var parseOptions = new CSharpParseOptions(LanguageVersion.Preview, preprocessorSymbols: defines);
    var tree = CSharpSyntaxTree.ParseText(text, parseOptions, rel);
    var syntaxRoot = tree.GetRoot();
    files.Add(new { path = rel, lines = tree.GetText().Lines.Count });

    foreach (var td in syntaxRoot.DescendantNodes().OfType<BaseTypeDeclarationSyntax>())
    {
        var ns = NamespaceOf(td);
        var nested = NestedName(td);
        var arity = td is TypeDeclarationSyntax g ? g.TypeParameterList?.Parameters.Count ?? 0 : 0;
        typeDecls.Add(new {
            path = rel, name = td.Identifier.ValueText, ns, nested,
            fullName = string.IsNullOrEmpty(ns) ? nested : ns + "." + nested,
            line = tree.GetLineSpan(td.Identifier.Span).StartLinePosition.Line + 1,
            kind = td.Kind().ToString(), partial = td.Modifiers.Any(SyntaxKind.PartialKeyword), arity
        });
    }

    foreach (var fd in syntaxRoot.DescendantNodes().OfType<BaseFieldDeclarationSyntax>())
    {
        var containing = fd.Ancestors().OfType<BaseTypeDeclarationSyntax>().FirstOrDefault();
        foreach (var v in fd.Declaration.Variables)
        {
            fields.Add(new {
                path = rel,
                line = tree.GetLineSpan(v.Identifier.Span).StartLinePosition.Line + 1,
                name = v.Identifier.ValueText,
                type = fd.Declaration.Type.ToString(),
                containing = containing == null ? null : ((string.IsNullOrEmpty(NamespaceOf(containing)) ? "" : NamespaceOf(containing) + ".") + NestedName(containing)),
                eventField = fd is EventFieldDeclarationSyntax
            });
        }
    }

    var initializers = new Dictionary<string, ExpressionSyntax>(StringComparer.Ordinal);
    foreach (var vd in syntaxRoot.DescendantNodes().OfType<VariableDeclaratorSyntax>())
    {
        if (vd.Initializer == null) continue;
        if (vd.Parent?.Parent is FieldDeclarationSyntax f &&
            (f.Modifiers.Any(SyntaxKind.ConstKeyword) || (f.Modifiers.Any(SyntaxKind.StaticKeyword) && f.Modifiers.Any(SyntaxKind.ReadOnlyKeyword))) &&
            f.Declaration.Type.ToString() is "string" or "System.String")
            initializers[vd.Identifier.ValueText] = vd.Initializer.Value;
        if (vd.Parent?.Parent is LocalDeclarationStatementSyntax l && l.Modifiers.Any(SyntaxKind.ConstKeyword) &&
            l.Declaration.Type.ToString() is "string" or "System.String")
            initializers[vd.Identifier.ValueText] = vd.Initializer.Value;
    }

    string? Fold(ExpressionSyntax e, HashSet<string>? seen = null)
    {
        seen ??= new(StringComparer.Ordinal);
        if (e is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.StringLiteralExpression)) return lit.Token.ValueText;
        if (e is ParenthesizedExpressionSyntax par) return Fold(par.Expression, seen);
        if (e is BinaryExpressionSyntax bin && bin.IsKind(SyntaxKind.AddExpression))
        {
            var a = Fold(bin.Left, seen); var b = Fold(bin.Right, seen);
            return a == null || b == null ? null : a + b;
        }
        if (e is IdentifierNameSyntax id && initializers.TryGetValue(id.Identifier.ValueText, out var init) && seen.Add(id.Identifier.ValueText))
            return Fold(init, seen);
        return null;
    }

    foreach (var inv in syntaxRoot.DescendantNodes().OfType<InvocationExpressionSyntax>())
    {
        var expr = inv.Expression.ToString();
        string? api = null;
        if (Regex.IsMatch(expr, @"(?:^|\.)Resources\s*\.\s*Load(?:All|Async)?(?:<.*>)?$")) api = "resources-key";
        else if (Regex.IsMatch(expr, @"(?:^|\.)AssetDatabase\s*\.\s*Load(?:AssetAtPath|MainAssetAtPath|AllAssetsAtPath|AllAssetRepresentationsAtPath)(?:<.*>)?$")) api = "asset-path";
        if (api == null) continue;
        var arg = inv.ArgumentList.Arguments.FirstOrDefault()?.Expression;
        var folded = arg == null ? null : Fold(arg);
        loads.Add(new {
            path = rel,
            line = tree.GetLineSpan(inv.Span).StartLinePosition.Line + 1,
            api,
            expression = arg?.ToString(), folded,
            invocation = inv.ToString()
        });
    }

    foreach (var trivia in syntaxRoot.DescendantTrivia(descendIntoTrivia: true))
    {
        var category = trivia.Kind() switch {
            SyntaxKind.SingleLineCommentTrivia or SyntaxKind.MultiLineCommentTrivia or SyntaxKind.SingleLineDocumentationCommentTrivia or SyntaxKind.MultiLineDocumentationCommentTrivia => "comment",
            SyntaxKind.DisabledTextTrivia => "disabled",
            _ => null
        };
        if (category == null) continue;
        if (category == "disabled")
        {
            var span = tree.GetLineSpan(trivia.Span);
            disabledRanges.Add(new { path = rel, startLine = span.StartLinePosition.Line + 1, endLine = span.EndLinePosition.Line + 1 });
        }
        var raw = trivia.ToFullString();
        foreach (Match m in rawLoad.Matches(raw))
            triviaLoads.Add(new {
                path = rel,
                line = tree.GetLineSpan(trivia.Span).StartLinePosition.Line + 1 + raw[..m.Index].Count(c => c == '\n'),
                category,
                snippet = raw.Substring(m.Index, Math.Min(180, raw.Length - m.Index)).Replace("\r", " ").Replace("\n", " ")
            });
    }
}

var payload = new { generatedAt = DateTimeOffset.Now, projectRoot = rootPath, configuredFiles = definesByFile.Count, files, typeDecls, fields, loads, triviaLoads, disabledRanges };
File.WriteAllText(outputPath, JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true }));
Console.WriteLine(JsonSerializer.Serialize(new { configuredFiles = definesByFile.Count, files = files.Count, types = typeDecls.Count, fields = fields.Count, loads = loads.Count, triviaLoads = triviaLoads.Count, disabledRanges = disabledRanges.Count }));
