// Compile the five build-only tool declarations with the host's own schema DSL.
// The distributed JS contains ordinary JSON Schemas and argument checks, so a
// link: installation never resolves dsh-tools from the plugin's real path.
import { readFile, writeFile } from 'node:fs/promises'
import ts from 'typescript'
import { defineTool } from '@deepseek-ai/dsh-tools'

const target = new URL('../lib/tools.js', import.meta.url)
const source = ts.createSourceFile('tools.js', await readFile(target, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const printer = ts.createPrinter()
const compiled = new Set()

function property(object, name) {
  const found = object.properties.find(p => p.name?.getText(source) === name)
  if (!found || !ts.isPropertyAssignment(found)) throw new Error(`Expected literal property ${name}`)
  return found.initializer
}

function literal(node) {
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return ts.isStringLiteral(node) ? node.text : Number(node.text)
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal)
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(p => {
    if (!ts.isPropertyAssignment(p)) throw new Error('Schema must contain only literal properties')
    return [p.name.text, literal(p.initializer)]
  }))
  throw new Error(`Schema is not a literal: ${node.getText(source)}`)
}

function statements(code) {
  function synthesized(node) {
    ts.setTextRange(node, { pos: -1, end: -1 })
    ts.forEachChild(node, synthesized)
    return node
  }
  return ts.createSourceFile('generated.js', code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS).statements.map(synthesized)
}

function expression(value) {
  return statements(`(${JSON.stringify(value)});`)[0].expression.expression
}

// All current public arguments are flat string/number fields. Fail the build if
// that changes, rather than silently weakening defineTool's argument validation.
function argumentChecks(schema) {
  const fields = Object.entries(schema.properties)
  for (const [, field] of fields) {
    if (!['string', 'number'].includes(field.type) || Object.keys(field).some(k => !['type', 'description'].includes(k))) {
      throw new Error('Update the standalone argument compiler for this schema')
    }
  }
  const checks = fields.map(([name, field]) => {
    const key = JSON.stringify(name)
    const valid = field.type === 'number' ? `typeof args[${key}] === 'number' && Number.isFinite(args[${key}])` : `typeof args[${key}] === 'string'`
    return `if (Object.hasOwn(args, ${key}) && !(${valid})) violations.push(${JSON.stringify(`${name}: expected ${field.type}`)});`
  }).join('\n')
  return statements(`
    const violations = [];
    if (args === null || typeof args !== 'object' || Array.isArray(args)) violations.push('expected object');
    else {
      for (const key of ${JSON.stringify(schema.required ?? [])}) if (!Object.hasOwn(args, key)) violations.push(key + ': required');
      ${checks}
      ${schema.additionalProperties === false ? `for (const key of Object.keys(args)) if (!${JSON.stringify(fields.map(([name]) => name))}.includes(key)) violations.push(key + ': unexpected property');` : ''}
    }
    if (violations.length) {
      const error = new HarnessError('invalid arguments: ' + violations.join('; '), 'INVALID_ARGS');
      error.name = 'ToolArgsError';
      error.violations = violations;
      throw error;
    }
  `)
}

const result = ts.transform(source, [context => {
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineVideoTool') {
      const options = node.arguments[0]
      if (!ts.isObjectLiteralExpression(options)) throw new Error('Tool declarations must be object literals')
      const name = literal(property(options, 'name'))
      const output = property(options, 'output')
      const tool = defineTool({
        name,
        description: literal(property(options, 'description')),
        parameters: literal(property(options, 'parameters')),
        output: { schema: literal(property(output, 'schema')), render: () => [] },
        async execute() {},
      })
      compiled.add(name)
      return ts.factory.updateObjectLiteralExpression(options, options.properties.map(p => {
        if (p.name?.getText(source) === 'parameters') return ts.factory.createPropertyAssignment('parameters', expression(tool.parameters))
        if (p.name?.getText(source) === 'output') return ts.factory.createPropertyAssignment('output', ts.factory.updateObjectLiteralExpression(output, output.properties.map(o =>
          o.name?.getText(source) === 'schema' ? ts.factory.createPropertyAssignment('schema', expression(tool.output.schema)) : o)))
        if (ts.isMethodDeclaration(p) && p.name.getText(source) === 'execute') return ts.factory.updateMethodDeclaration(p,
          p.modifiers, p.asteriskToken, p.name, p.questionToken, p.typeParameters, p.parameters, p.type,
          ts.factory.updateBlock(p.body, [...argumentChecks(tool.parameters), ...p.body.statements]))
        return p
      }))
    }
    return ts.visitEachChild(node, visit, context)
  }
  return node => ts.visitNode(node, visit)
}])

try {
  if (compiled.size !== 5) throw new Error(`Expected five tools, compiled ${compiled.size}`)
  const output = `// Generated by npm run build; do not edit.\nimport { HarnessError } from '@deepseek-ai/dsh-llm';\n${printer.printFile(result.transformed[0])}`
  if (output.includes('defineVideoTool(') || /from ['"]@deepseek-ai\/dsh-tools['"]/.test(output)) throw new Error('Uncompiled runtime dependency')
  await writeFile(target, output)
  console.log(`Compiled literal schemas: ${[...compiled].join(', ')}`)
} finally {
  result.dispose()
}
