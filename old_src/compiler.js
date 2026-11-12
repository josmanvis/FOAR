"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const peggy = __importStar(require("peggy"));
// 1. Read the Grammar
const grammarPath = path.resolve(__dirname, 'grammar.pegjs');
const grammar = fs.readFileSync(grammarPath, 'utf-8');
// 2. Generate the Parser dynamically for prototyping
const parser = peggy.generate(grammar);
// 3. Read the FSL source code
const sourcePath = path.resolve(__dirname, 'main.fsl');
const source = fs.readFileSync(sourcePath, 'utf-8');
// 4. Parse the FSL source to an AST
try {
    const ast = parser.parse(source);
    console.log("✅ Successfully parsed AST:");
    console.log(JSON.stringify(ast, null, 2));
    // 5. Transpile to LSL
    const lslOutput = transpileToLSL(ast);
    console.log("\n🚀 Transpiled LSL Output:");
    console.log("--------------------------");
    console.log(lslOutput);
    console.log("--------------------------");
    const outputPath = path.resolve(__dirname, 'main.lsl');
    fs.writeFileSync(outputPath, lslOutput, 'utf-8');
    console.log(`\nWritten compiled output to ${outputPath}`);
}
catch (err) {
    if (typeof err.format === 'function') {
        console.error("Syntax Error:\n" + err.format([{ source: "main.fsl", text: source }]));
    }
    else {
        console.error("Error:", err.message);
    }
}
// Basic AST to LSL Transpiler
function transpileToLSL(ast) {
    if (ast.type !== 'Program')
        return '';
    let lsl = '';
    for (const state of ast.states) {
        lsl += `state ${state.name}\n{\n`;
        for (const event of state.events) {
            // Map FSL event names to actual LSL event names
            let eventName = event.name;
            if (eventName === 'on_entry')
                eventName = 'state_entry';
            if (eventName === 'on_touch')
                eventName = 'touch_start';
            if (eventName === 'on_exit')
                eventName = 'state_exit';
            // Map FSL types to LSL types (optional mapping rules here)
            const params = event.params.map((p) => {
                let type = p.paramType;
                if (type === 'number')
                    type = 'float';
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
function transpileStatement(stmt) {
    switch (stmt.type) {
        case 'PrintStatement':
            // In LSL, we usually print debug messages with llOwnerSay
            // LSL concatenation uses +, but we should handle types eventually.
            // For strings, we cast (string)var. But we'll keep it simple here.
            return `llOwnerSay((string)(${transpileExpression(stmt.expression)}));`;
        case 'TransitionStatement':
            return `state ${stmt.target};`;
        case 'ExpressionStatement':
            return `${transpileExpression(stmt.expression)};`;
        default:
            return `// Unknown statement type: ${stmt.type}`;
    }
}
function transpileExpression(expr) {
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
//# sourceMappingURL=compiler.js.map