import fs from 'node:fs';
import path from 'node:path';
import { parse } from './parser.js';

// 1. Read the FSL source code
const sourcePath = path.resolve(import.meta.dirname, 'main.fsl');
const source = fs.readFileSync(sourcePath, 'utf-8');

// 2. Parse the FSL source to an AST
try {
    const ast = parse(source);
    console.log("✅ Successfully parsed AST:");
    console.log(JSON.stringify(ast, null, 2));

    // 3. Transpile to LSL
    const lslOutput = transpileToLSL(ast);
    console.log("\n🚀 Transpiled LSL Output:");
    console.log("--------------------------");
    console.log(lslOutput);
    console.log("--------------------------");
    
    const outputPath = path.resolve(import.meta.dirname, 'main.lsl');
    fs.writeFileSync(outputPath, lslOutput, 'utf-8');
    console.log(`\nWritten compiled output to ${outputPath}`);
} catch (err: any) {
    if (typeof err.format === 'function') {
        console.error("Syntax Error:\n" + err.format([{ source: "main.fsl", text: source }]));
    } else {
        console.error("Error:", err.message);
    }
}

// Basic AST to LSL Transpiler
function transpileToLSL(ast: any): string {
    if (ast.type !== 'Program') return '';

    let lsl = '';
    for (const state of ast.states) {
        lsl += `state ${state.name}\n{\n`;
        for (const event of state.events) {
            // Map FSL event names to actual LSL event names
            let eventName = event.name;
            if (eventName === 'on_entry') eventName = 'state_entry';
            if (eventName === 'on_touch') eventName = 'touch_start';
            if (eventName === 'on_exit') eventName = 'state_exit';

            // Map FSL types to LSL types (optional mapping rules here)
            const params = event.params.map((p: any) => {
                let type = p.paramType;
                if (type === 'number') type = 'float';
                return `${type} ${p.name}`;
            }).join(', ');
            
            lsl += `    ${eventName}(${params})\n    {\n`;

            for (const stmt of event.body) {
                lsl += `        ${transpileStatement(stmt)}\n`;
            }

            lsl += `    }\n`;
        }
        lsl += `}\n\n`;
    }
    return lsl.trim() + '\n';
}

function transpileStatement(stmt: any): string {
    switch (stmt.type) {
        case 'PrintStatement':
            return `llOwnerSay((string)(${transpileExpression(stmt.expression)}));`;
        case 'TransitionStatement':
            return `state ${stmt.target};`;
        case 'ExpressionStatement':
            return `${transpileExpression(stmt.expression)};`;
        default:
            return `// Unknown statement type: ${stmt.type}`;
    }
}

function transpileExpression(expr: any): string {
    switch (expr.type) {
        case 'StringLiteral':
            return `"${expr.value}"`;
        case 'NumberLiteral':
            return expr.value.toString();
        case 'Identifier':
            return expr.value;
        case 'BinaryExpression':
            return `${transpileExpression(expr.left)} ${expr.operator} ${transpileExpression(expr.right)}`;
        default:
            return `/* Unknown expr ${expr.type} */`;
    }
}
