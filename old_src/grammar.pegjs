// Peggy Grammar for FSL (FOAR Scripting Language)
// This file defines the syntax rules and builds an Abstract Syntax Tree (AST).

{
  // Initialization block
}

Program
  = _ states:State* { return { type: "Program", states: states }; }

State
  = "state" _ name:Identifier _ "{" _ events:Event* _ "}" _ {
      return { type: "State", name: name.value, events: events };
    }

Event
  = name:Identifier _ "(" _ params:Params? _ ")" _ "{" _ body:Statement* _ "}" _ {
      return { type: "Event", name: name.value, params: params || [], body: body };
    }

Params
  = head:Param tail:(_ "," _ Param)* {
      return [head, ...tail.map(t => t[3])];
    }

Param
  = type:Identifier _ name:Identifier {
      return { type: "Param", paramType: type.value, name: name.value };
    }

Statement
  = PrintStatement
  / TransitionStatement
  / ExpressionStatement

PrintStatement
  = "print" _ "(" _ expr:Expression _ ")" _ ";" _ {
      return { type: "PrintStatement", expression: expr };
    }

TransitionStatement
  = "transition" _ target:Identifier _ ";" _ {
      return { type: "TransitionStatement", target: target.value };
    }

ExpressionStatement
  = expr:Expression _ ";" _ {
      return { type: "ExpressionStatement", expression: expr };
    }

Expression
  = AdditionExpression

AdditionExpression
  = left:PrimaryExpression _ "+" _ right:AdditionExpression {
      return { type: "BinaryExpression", operator: "+", left: left, right: right };
    }
  / PrimaryExpression

PrimaryExpression
  = StringLiteral
  / NumberLiteral
  / Identifier

StringLiteral
  = '"' chars:[^"]* '"' { return { type: "StringLiteral", value: chars.join("") }; }

NumberLiteral
  = digits:[0-9]+ { return { type: "NumberLiteral", value: parseInt(digits.join(""), 10) }; }

Identifier
  = chars:([a-zA-Z_][a-zA-Z0-9_]*) { return { type: "Identifier", value: text() }; }

_ "whitespace"
  = ([ \t\n\r] / Comment)*

Comment
  = "//" [^\n]*
