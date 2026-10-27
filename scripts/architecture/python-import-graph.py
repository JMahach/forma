#!/usr/bin/env python3
"""Read Python syntax only. Never import or execute analyzed project modules."""
import argparse
import ast
import hashlib
import json
import platform
from pathlib import Path

EXCLUDED = {'tests', 'node_modules', 'dist', '.git', '.venv', '__pycache__'}


def tarjan(nodes, edges):
    adjacency = {node: set() for node in nodes}
    for source, target in edges:
        adjacency[source].add(target)
    next_index = 0
    indices, low, stack, on_stack, components = {}, {}, [], set(), []

    def visit(node):
        nonlocal next_index
        indices[node] = low[node] = next_index
        next_index += 1
        stack.append(node)
        on_stack.add(node)
        for target in sorted(adjacency[node]):
            if target not in indices:
                visit(target)
                low[node] = min(low[node], low[target])
            elif target in on_stack:
                low[node] = min(low[node], indices[target])
        if low[node] == indices[node]:
            component = []
            while True:
                member = stack.pop()
                on_stack.remove(member)
                component.append(member)
                if member == node:
                    break
            components.append(sorted(component))

    for node in sorted(nodes):
        if node not in indices:
            visit(node)
    components.sort(key=lambda part: part[0])
    cycles = [part for part in components if len(part) > 1 or part[0] in adjacency[part[0]]]
    return {'components': components, 'cyclicComponents': cycles}


def validate_tarjan():
    cases = [
        ('DAG', ['a', 'b', 'c'], [('a', 'b'), ('b', 'c')], []),
        ('pair_cycle', ['a', 'b', 'c'], [('a', 'b'), ('b', 'a')], [['a', 'b']]),
        ('self_loop', ['a', 'b'], [('a', 'a'), ('a', 'b')], [['a']]),
    ]
    results = []
    for name, nodes, edges, expected in cases:
        actual = tarjan(nodes, edges)['cyclicComponents']
        results.append({'name': name, 'nodes': nodes, 'edges': edges, 'expected': expected,
                        'actual': actual, 'passed': actual == expected})
    if not all(item['passed'] for item in results):
        raise AssertionError('Tarjan control failed')
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    policy = json.loads(Path(__file__).with_name('architecture-boundaries.json').read_text(encoding='utf-8'))
    included_roots = policy['scope']['roots']
    paths = sorted(path for top in included_roots for path in (root / top).rglob('*.py')
                   if path.is_file() and not any(part in EXCLUDED for part in path.relative_to(root).parts))
    files, trees, parse_errors = {}, {}, []
    for path in paths:
        relative = path.relative_to(root).as_posix()
        raw = path.read_bytes()
        files[relative] = {'path': relative, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
        try:
            trees[relative] = ast.parse(raw, filename=relative)
        except (SyntaxError, UnicodeError) as error:
            parse_errors.append({'path': relative, 'error': str(error)})
    file_set = set(files)
    namespaces = set()
    for file in files:
        for parent in Path(file).parents:
            if str(parent) != '.':
                namespaces.add(parent.as_posix().replace('/', '.'))
    module_paths = {}
    for file in files:
        parts = list(Path(file).with_suffix('').parts)
        if parts[-1] == '__init__':
            parts.pop()
        module_paths['.'.join(parts)] = file

    def resolve_module(module, source, relative=False):
        if module in module_paths:
            return {'classification': 'internal', 'target': module_paths[module], 'resolution': 'root_package'}
        if module in namespaces:
            return {'classification': 'namespace', 'module': module, 'resolution': 'root_package'}
        # Direct Python script execution puts its own directory on sys.path.
        # The source explicitly contains fallbacks for this mode.
        if not relative and module:
            candidate = str(Path(source).parent / Path(*module.split('.'))).replace('/', '.')
            if candidate in module_paths:
                return {'classification': 'internal', 'target': module_paths[candidate],
                        'resolution': 'direct_script_sibling_candidate', 'assumption': 'script directory is on sys.path'}
            if candidate in namespaces:
                return {'classification': 'namespace', 'module': candidate,
                        'resolution': 'direct_script_sibling_candidate', 'assumption': 'script directory is on sys.path'}
        return {'classification': 'unresolved_relative' if relative else 'external', 'module': module,
                'resolution': 'not_present_in_analyzed_roots'}

    def relative_module(source, module, level):
        package = list(Path(source).parent.parts)
        if level > len(package):
            return None
        prefix = package[:len(package) - level + 1]
        return '.'.join(prefix + (module.split('.') if module else []))

    records, dynamic, edges = [], [], set()

    def add(source, node, kind, module, resolution, **extra):
        record = {'source': source, 'line': node.lineno, 'column': node.col_offset + 1,
                  'kind': kind, 'module': module, **resolution, **extra}
        records.append(record)
        if resolution['classification'] == 'internal':
            edges.add((source, resolution['target']))

    for source, tree in sorted(trees.items()):
        aliases = {'importlib'}
        importer_names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for name in node.names:
                    if name.name == 'importlib':
                        aliases.add(name.asname or name.name)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module == 'importlib':
                for name in node.names:
                    if name.name == 'import_module':
                        importer_names.add(name.asname or name.name)
        for node in sorted(ast.walk(tree), key=lambda item: (getattr(item, 'lineno', 0), getattr(item, 'col_offset', 0))):
            if isinstance(node, ast.Import):
                for name in node.names:
                    add(source, node, 'import', name.name, resolve_module(name.name, source), alias=name.asname)
            elif isinstance(node, ast.ImportFrom):
                relative = node.level > 0
                module = relative_module(source, node.module, node.level) if relative else node.module
                spelling = '.' * node.level + (node.module or '')
                if module is None:
                    add(source, node, 'from', spelling,
                        {'classification': 'unresolved_relative', 'resolution': 'relative_level_above_project_root'},
                        importedNames=[name.name for name in node.names])
                    continue
                base = resolve_module(module, source, relative)
                add(source, node, 'from', spelling, base,
                    resolvedModule=module, importedNames=[name.name for name in node.names])
                # Imported names may be attributes. Only add a submodule when a
                # matching source file/package is actually present, never invent one.
                for name in node.names:
                    if name.name == '*':
                        continue
                    child = module + '.' + name.name
                    resolved = resolve_module(child, source, relative)
                    if resolved['classification'] == 'internal':
                        add(source, node, 'from_member_module', child, resolved, alias=name.asname)
                    elif base['classification'] == 'namespace':
                        add(source, node, 'from_member', child,
                            {'classification': 'unresolved_relative' if relative else 'unresolved_internal_member',
                             'resolution': 'no_matching_submodule_attribute_not_proven'}, alias=name.asname)
            elif isinstance(node, ast.Call):
                function = node.func
                builtin = isinstance(function, ast.Name) and function.id == '__import__'
                importlib_call = (isinstance(function, ast.Attribute) and function.attr == 'import_module'
                                  and isinstance(function.value, ast.Name) and function.value.id in aliases)
                named_call = isinstance(function, ast.Name) and function.id in importer_names
                if not (builtin or importlib_call or named_call):
                    continue
                method = '__import__' if builtin else 'importlib.import_module'
                argument = node.args[0] if node.args else next((kw.value for kw in node.keywords if kw.arg == 'name'), None)
                literal = argument.value if isinstance(argument, ast.Constant) and isinstance(argument.value, str) else None
                item = {'source': source, 'line': node.lineno, 'column': node.col_offset + 1,
                        'kind': 'dynamic_import', 'method': method, 'argument': ast.dump(argument) if argument else None,
                        'literal': literal, 'classification': 'untraceable_dynamic'}
                if literal is not None:
                    if literal.startswith('.'):
                        package_arg = (node.args[1] if len(node.args) > 1 else next((kw.value for kw in node.keywords if kw.arg == 'package'), None)) if not builtin else None
                        package = package_arg.value if isinstance(package_arg, ast.Constant) and isinstance(package_arg.value, str) else None
                        if package:
                            level = len(literal) - len(literal.lstrip('.'))
                            parts = package.split('.')
                            suffix = literal.lstrip('.')
                            if level <= len(parts):
                                module = '.'.join(parts[:len(parts)-level+1] + ([suffix] if suffix else []))
                                item.update(resolve_module(module, source, True))
                            else:
                                item['reason'] = 'relative_level_above_literal_package'
                        else:
                            item['reason'] = 'relative_dynamic_import_without_literal_package'
                    elif builtin and (len(node.args) > 4 or any(kw.arg == 'level' for kw in node.keywords)):
                        item['reason'] = '__import___level_requires_separate_semantics'
                    else:
                        item.update(resolve_module(literal, source))
                    if item['classification'] == 'internal':
                        edges.add((source, item['target']))
                else:
                    item['reason'] = 'nonliteral_module_name'
                dynamic.append(item)
    graph = tarjan(files, edges)
    external = [record for record in records if record['classification'] == 'external']
    unresolved = [record for record in records if record['classification'].startswith('unresolved')]
    drift = []
    for file, metadata in files.items():
        path = root / file
        if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != metadata['sha256']:
            drift.append(file)
    result = {
        'schemaVersion': 1, 'root': str(root), 'tool': 'Python ast, no project module execution',
        'pythonVersion': platform.python_version(),
        'scope': {'includedRoots': included_roots, 'extensions': ['.py'], 'excludedDirectoryNames': sorted(EXCLUDED)},
        'files': list(files.values()), 'imports': records, 'dynamicImports': dynamic,
        'edges': [{'source': source, 'target': target} for source, target in sorted(edges)],
        'external': external, 'unresolved': unresolved, 'parseErrors': parse_errors,
        'sourceFilesChangedDuringRead': drift,
        'tarjanControls': validate_tarjan(), 'stronglyConnectedComponents': graph,
        'summary': {'files': len(files), 'importRecords': len(records), 'uniqueInternalEdges': len(edges),
                    'externalRecords': len(external), 'externalModules': len(set(record['module'] for record in external)),
                    'unresolvedRecords': len(unresolved), 'dynamicImportCalls': len(dynamic),
                    'untraceableDynamicImports': sum(record['classification'] == 'untraceable_dynamic' for record in dynamic),
                    'parseErrors': len(parse_errors), 'cyclicComponents': len(graph['cyclicComponents']),
                    'sourceFilesChangedDuringRead': len(drift)},
        'limitations': [
            'Conservative union of all syntactic branches, nested functions and fallback imports; does not prove an import executes in any scenario.',
            'Bare sibling names are resolved as direct-script candidates; this assumes the script directory is on sys.path and is recorded per edge.',
            'External classification means no source in the analyzed roots; availability, package versions and stdlib/third-party distinction are not verified.',
            'Python namespace packages have no source-file vertex; imported members become edges only if a matching module exists. Attributes are not invented as modules.',
            'Recognizes syntactic __import__, importlib.import_module, and direct aliases; does not resolve arbitrary aliases, scope shadowing, eval/exec or monkey-patched loaders.',
            'Does not infer imports from subprocess calls, file reads, callbacks, reflection or data contracts. Node-to-Python worker invocation is a separate execution relationship.',
            'Graph records explicit source import syntax and matching member modules, not implicit package __init__ execution or dependencies of external packages.',
            'No approved ownership/allowed-dependency matrix is inferred from existing code; this output supplies evidence for a separately declared architecture.',
        ],
    }
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result['summary'], ensure_ascii=False))
    if parse_errors or drift:
        raise SystemExit(2)


if __name__ == '__main__':
    main()
