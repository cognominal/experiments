import * as ts from "typescript";

export type Associativity = "left" | "right" | "non";

export interface EmitContext {
  readonly ts: typeof ts;
}

export interface PrefixOperator {
  readonly kind: "prefix";
  readonly symbol: string;
  readonly bindingPower: number;
  emit(context: EmitContext, operand: ts.Expression): ts.Expression;
}

export interface PostfixOperator {
  readonly kind: "postfix";
  readonly symbol: string;
  readonly bindingPower: number;
  emit(context: EmitContext, operand: ts.Expression): ts.Expression;
}

export interface InfixOperator {
  readonly kind: "infix";
  readonly symbol: string;
  readonly bindingPower: number;
  readonly associativity: Associativity;
  emit(context: EmitContext, left: ts.Expression, right: ts.Expression): ts.Expression;
}

export interface CircumfixOperator {
  readonly kind: "circumfix";
  readonly open: string;
  readonly close: string;
  emit(context: EmitContext, expressions: ts.Expression[]): ts.Expression;
}

export interface PostcircumfixOperator {
  readonly kind: "postcircumfix";
  readonly open: string;
  readonly close: string;
  readonly bindingPower: number;
  emit(context: EmitContext, target: ts.Expression, expressions: ts.Expression[]): ts.Expression;
}

export interface InfixConfig {
  readonly bindingPower: number;
  readonly associativity?: Associativity;
  emit(context: EmitContext, left: ts.Expression, right: ts.Expression): ts.Expression;
}

export interface UnaryConfig {
  readonly bindingPower: number;
  emit(context: EmitContext, operand: ts.Expression): ts.Expression;
}

export interface CircumfixConfig {
  emit(context: EmitContext, expressions: ts.Expression[]): ts.Expression;
}

export interface PostcircumfixConfig {
  readonly bindingPower: number;
  emit(context: EmitContext, target: ts.Expression, expressions: ts.Expression[]): ts.Expression;
}

interface Token {
  readonly kind: "identifier" | "variable" | "number" | "string" | "symbol" | "comma" | "colon" | "eof";
  readonly value: string;
  readonly position: number;
}

interface TokenizerState {
  readonly source: string;
  readonly symbols: readonly string[];
  index: number;
}

interface PairParts {
  readonly key: ts.Expression;
  readonly value: ts.Expression;
}

interface ParsedNode {
  readonly expression: ts.Expression;
  readonly bareword?: string;
  readonly pair?: PairParts;
  readonly listItems?: readonly ParsedNode[];
}

const BUILTIN_SYMBOLS = ["=>", "=", ".", "<<", ">>", "«", "»", "(", ")", "[", "]", "{", "}", "<", ">"];

export class OperatorScope {
  readonly parent?: OperatorScope;
  private readonly prefixOperators = new Map<string, PrefixOperator>();
  private readonly postfixOperators = new Map<string, PostfixOperator>();
  private readonly infixOperators = new Map<string, InfixOperator>();
  private readonly circumfixOperators = new Map<string, CircumfixOperator>();
  private readonly postcircumfixOperators = new Map<string, PostcircumfixOperator>();
  private readonly closingSymbols = new Set<string>();

  constructor(parent?: OperatorScope) {
    this.parent = parent;
  }

  child(): OperatorScope {
    return new OperatorScope(this);
  }

  prefix(symbol: string, config: UnaryConfig): this {
    this.prefixOperators.set(symbol, {
      kind: "prefix",
      symbol,
      bindingPower: config.bindingPower,
      emit: config.emit,
    });
    return this;
  }

  postfix(symbol: string, config: UnaryConfig): this {
    this.postfixOperators.set(symbol, {
      kind: "postfix",
      symbol,
      bindingPower: config.bindingPower,
      emit: config.emit,
    });
    return this;
  }

  infix(symbol: string, config: InfixConfig): this {
    this.infixOperators.set(symbol, {
      kind: "infix",
      symbol,
      bindingPower: config.bindingPower,
      associativity: config.associativity ?? "left",
      emit: config.emit,
    });
    return this;
  }

  circumfix(open: string, close: string, config: CircumfixConfig): this {
    this.circumfixOperators.set(open, {
      kind: "circumfix",
      open,
      close,
      emit: config.emit,
    });
    this.closingSymbols.add(close);
    return this;
  }

  postcircumfix(open: string, close: string, config: PostcircumfixConfig): this {
    this.postcircumfixOperators.set(open, {
      kind: "postcircumfix",
      open,
      close,
      bindingPower: config.bindingPower,
      emit: config.emit,
    });
    this.closingSymbols.add(close);
    return this;
  }

  lookupPrefix(symbol: string): PrefixOperator | undefined {
    return this.prefixOperators.get(symbol) ?? this.parent?.lookupPrefix(symbol);
  }

  lookupPostfix(symbol: string): PostfixOperator | undefined {
    return this.postfixOperators.get(symbol) ?? this.parent?.lookupPostfix(symbol);
  }

  lookupInfix(symbol: string): InfixOperator | undefined {
    return this.infixOperators.get(symbol) ?? this.parent?.lookupInfix(symbol);
  }

  lookupCircumfix(open: string): CircumfixOperator | undefined {
    return this.circumfixOperators.get(open) ?? this.parent?.lookupCircumfix(open);
  }

  lookupPostcircumfix(open: string): PostcircumfixOperator | undefined {
    return this.postcircumfixOperators.get(open) ?? this.parent?.lookupPostcircumfix(open);
  }

  collectSymbols(): string[] {
    const symbols = new Set<string>(BUILTIN_SYMBOLS);
    for (const scope of this.lineage()) {
      for (const symbol of scope.prefixOperators.keys()) symbols.add(symbol);
      for (const symbol of scope.postfixOperators.keys()) symbols.add(symbol);
      for (const symbol of scope.infixOperators.keys()) symbols.add(symbol);
      for (const symbol of scope.circumfixOperators.keys()) symbols.add(symbol);
      for (const operator of scope.circumfixOperators.values()) symbols.add(operator.close);
      for (const symbol of scope.postcircumfixOperators.keys()) symbols.add(symbol);
      for (const operator of scope.postcircumfixOperators.values()) symbols.add(operator.close);
    }
    return [...symbols].sort((left, right) => right.length - left.length || left.localeCompare(right));
  }

  private lineage(): OperatorScope[] {
    const scopes: OperatorScope[] = [];
    for (let current: OperatorScope | undefined = this; current; current = current.parent) {
      scopes.push(current);
    }
    return scopes;
  }
}

export interface ParseResult {
  readonly expression: ts.Expression;
  readonly printer: ts.Printer;
  readonly sourceFile: ts.SourceFile;
  print(): string;
}

export function parseExpression(source: string, scope: OperatorScope): ParseResult {
  const tokenizer = createTokenizer(source, scope.collectSymbols());
  const parser = new PrattParser(tokenizer, scope);
  const expression = materializeNode(parser.parse());
  const printer = ts.createPrinter();
  const sourceFile = ts.createSourceFile("expr.ts", "", ts.ScriptTarget.ESNext, false, ts.ScriptKind.TS);

  return {
    expression,
    printer,
    sourceFile,
    print() {
      return printer.printNode(ts.EmitHint.Expression, expression, sourceFile);
    },
  };
}

class PrattParser {
  private readonly context: EmitContext = { ts };
  private lookahead: Token;

  constructor(
    private readonly tokenizer: TokenizerState,
    private readonly scope: OperatorScope,
  ) {
    this.lookahead = nextToken(this.tokenizer);
  }

  parse(): ParsedNode {
    const expression = this.parseExpression(0);
    this.expect("eof");
    return expression;
  }

  private parseExpression(minBindingPower: number): ParsedNode {
    let left = this.parseHead();

    while (true) {
      if (this.lookahead.kind === "comma") {
        const bindingPower = 2;
        if (bindingPower < minBindingPower) {
          break;
        }

        this.consume("comma");
        const right = this.parseExpression(bindingPower + 1);
        left = createListNode([...flattenListNodes(left), ...flattenListNodes(right)]);
        continue;
      }

      if (this.lookahead.kind !== "symbol") {
        if (
          minBindingPower <= 90 &&
          canImplicitlyCall(left) &&
          this.startsImplicitArgumentList()
        ) {
          const argumentsNode = this.parseExpression(0);
          left = createNode(
            ts.factory.createCallExpression(materializeNode(left), undefined, flattenListItems(argumentsNode)),
          );
          continue;
        }
        break;
      }

      if (this.lookahead.value === ".") {
        this.consumeSymbol(".");
        const property = this.consume("identifier");
        const methodTarget = ts.factory.createPropertyAccessExpression(
          materializeNode(left),
          ts.factory.createIdentifier(property.value),
        );

        if (this.isColonAhead()) {
          const argumentsNode = this.parseColonArguments();
          left = createNode(ts.factory.createCallExpression(methodTarget, undefined, flattenListItems(argumentsNode)));
          continue;
        }

        left = createNode(methodTarget);
        continue;
      }

      const postcircumfix = this.scope.lookupPostcircumfix(this.lookahead.value);
      if (postcircumfix && postcircumfix.bindingPower >= minBindingPower) {
        this.consumeSymbol(postcircumfix.open);
        const expressions = this.parseDelimited(postcircumfix.close);
        left = createNode(
          postcircumfix.emit(this.context, materializeNode(left), expressions),
        );
        continue;
      }

      const postfix = this.scope.lookupPostfix(this.lookahead.value);
      if (postfix && postfix.bindingPower >= minBindingPower) {
        this.consumeSymbol(postfix.symbol);
        left = createNode(postfix.emit(this.context, materializeNode(left)));
        continue;
      }

      const infix = this.scope.lookupInfix(this.lookahead.value);
      if (!infix || infix.bindingPower < minBindingPower) {
        break;
      }

      this.consumeSymbol(infix.symbol);
      const nextMinBindingPower =
        infix.associativity === "right" ? infix.bindingPower : infix.bindingPower + 1;
      const right = this.parseExpression(nextMinBindingPower);

      if (infix.symbol === "=>") {
        left = createPairNode(normalizePairKey(left), materializeNode(right));
        continue;
      }

      if (infix.symbol === "=") {
        assertAssignable(materializeNode(left));
      }

      left = createNode(infix.emit(this.context, materializeNode(left), materializeNode(right)));
    }

    return left;
  }

  private parseHead(): ParsedNode {
    if (this.lookahead.kind === "number") {
      const token = this.consume("number");
      return createNode(ts.factory.createNumericLiteral(token.value));
    }

    if (this.lookahead.kind === "string") {
      const token = this.consume("string");
      return createNode(ts.factory.createStringLiteral(token.value));
    }

    if (this.lookahead.kind === "variable") {
      const token = this.consume("variable");
      return createNode(ts.factory.createIdentifier(stripSigil(token.value)));
    }

    if (this.lookahead.kind === "identifier") {
      const token = this.consume("identifier");
      return createNode(identifierExpression(token.value), token.value);
    }

    if (this.lookahead.kind === "colon") {
      return this.parseColonPair();
    }

    if (this.lookahead.kind === "symbol") {
      if (this.lookahead.value === ".") {
        this.consumeSymbol(".");
        const method = this.consume("identifier");
        const target = ts.factory.createPropertyAccessExpression(
          ts.factory.createIdentifier("$_"),
          ts.factory.createIdentifier(method.value),
        );

        if (this.isColonAhead()) {
          const argumentsNode = this.parseColonArguments();
          return createNode(ts.factory.createCallExpression(target, undefined, flattenListItems(argumentsNode)));
        }

        if (this.isSymbolAhead("(")) {
          this.consumeSymbol("(");
          const expressions = this.parseDelimited(")");
          return createNode(ts.factory.createCallExpression(target, undefined, expressions));
        }

        return createNode(ts.factory.createCallExpression(target, undefined, []));
      }

      if (this.lookahead.value === "(") {
        this.consumeSymbol("(");
        if (this.isSymbolAhead(")")) {
          this.consumeSymbol(")");
          return createListNode([]);
        }

        const inner = this.parseExpression(0);
        this.consumeSymbol(")");

        if (inner.listItems) {
          return inner;
        }

        return createNode(ts.factory.createParenthesizedExpression(materializeNode(inner)));
      }

      if (this.lookahead.value === "[") {
        return this.parseArrayLiteral();
      }

      if (this.lookahead.value === "{") {
        return this.parseHashLiteral();
      }

      const prefix = this.scope.lookupPrefix(this.lookahead.value);
      if (prefix) {
        this.consumeSymbol(prefix.symbol);
        const operand = this.parseExpression(prefix.bindingPower);
        return createNode(prefix.emit(this.context, materializeNode(operand)));
      }

      const circumfix = this.scope.lookupCircumfix(this.lookahead.value);
      if (circumfix) {
        this.consumeSymbol(circumfix.open);
        const expressions = this.parseDelimited(circumfix.close);
        return createNode(circumfix.emit(this.context, expressions));
      }
    }

    throw new Error(`Unexpected token ${describeToken(this.lookahead)} at ${this.lookahead.position}`);
  }

  private parseColonPair(): ParsedNode {
    this.consume("colon");

    if (this.lookahead.kind === "variable") {
      const token = this.consume("variable");
      const name = stripSigil(token.value);
      return createPairNode(ts.factory.createStringLiteral(name), ts.factory.createIdentifier(name));
    }

    if (this.lookahead.kind === "symbol" && this.lookahead.value === "!") {
      this.consumeSymbol("!");
      const key = this.consumePairKey();
      return createPairNode(ts.factory.createStringLiteral(key), ts.factory.createFalse());
    }

    if (this.lookahead.kind === "number") {
      const value = this.consume("number");
      const key = this.consumePairKey();
      return createPairNode(ts.factory.createStringLiteral(key), ts.factory.createNumericLiteral(value.value));
    }

    const keyToken = this.consume("identifier");
    const explicitValue = this.tryParseExplicitColonPairValue(keyToken.value);
    if (explicitValue) {
      return createPairNode(ts.factory.createStringLiteral(keyToken.value), explicitValue);
    }

    const numericSuffix = splitNumericPairSuffix(keyToken.value);
    if (numericSuffix) {
      return createPairNode(
        ts.factory.createStringLiteral(numericSuffix.key),
        ts.factory.createNumericLiteral(numericSuffix.value),
      );
    }

    return createPairNode(ts.factory.createStringLiteral(keyToken.value), ts.factory.createTrue());
  }

  private tryParseExplicitColonPairValue(key: string): ts.Expression | undefined {
    if (this.lookahead.kind !== "symbol") {
      return undefined;
    }

    if (this.lookahead.value === "(") {
      this.consumeSymbol("(");
      const expressions = this.parseDelimitedNodes(")");
      return collapseDelimitedValue(expressions.map((expression) => materializeNode(expression)));
    }

    if (this.lookahead.value === "[") {
      return materializeNode(this.parseArrayLiteral());
    }

    if (this.lookahead.value === "{") {
      return materializeNode(this.parseHashLiteral());
    }

    if (this.lookahead.value === "<" || this.lookahead.value === "<<" || this.lookahead.value === "«") {
      return this.parseQuotedWords(this.lookahead.value, matchingQuoteCloser(this.lookahead.value), key);
    }

    return undefined;
  }

  private parseQuotedWords(openSymbol: string, closeSymbol: string, key: string): ts.Expression {
    this.consumeSymbol(openSymbol);

    const words: string[] = [];
    while (!(this.lookahead.kind === "symbol" && this.lookahead.value === closeSymbol)) {
      if (this.lookahead.kind === "eof") {
        throw new Error(`Unterminated colon-pair quoted value for ${key}`);
      }

      if (this.lookahead.kind === "identifier" || this.lookahead.kind === "number" || this.lookahead.kind === "string") {
        words.push(this.lookahead.value);
        this.lookahead = nextToken(this.tokenizer);
        continue;
      }

      if (this.lookahead.kind === "variable") {
        words.push(stripSigil(this.lookahead.value));
        this.lookahead = nextToken(this.tokenizer);
        continue;
      }

      throw new Error(`Unsupported token ${describeToken(this.lookahead)} inside colon-pair quote`);
    }

    this.consumeSymbol(closeSymbol);

    if (words.length === 1) {
      return ts.factory.createStringLiteral(words[0]);
    }

    return ts.factory.createArrayLiteralExpression(
      words.map((word) => ts.factory.createStringLiteral(word)),
      false,
    );
  }

  private parseArrayLiteral(): ParsedNode {
    this.consumeSymbol("[");
    const expressions = this.parseDelimited("]");
    return createNode(ts.factory.createArrayLiteralExpression(expressions, false));
  }

  private parseHashLiteral(): ParsedNode {
    this.consumeSymbol("{");

    if (this.lookahead.kind === "symbol" && this.lookahead.value === "}") {
      this.consumeSymbol("}");
      return createNode(ts.factory.createObjectLiteralExpression([], false));
    }

    const entries = this.parseDelimitedNodes("}");

    const properties = entries.map((entry) => {
      if (!entry.pair) {
        throw new Error("Hash literals currently require pair entries");
      }
      return createPropertyFromPair(entry.pair);
    });

    return createNode(ts.factory.createObjectLiteralExpression(properties, false));
  }

  private parseDelimited(closeSymbol: string): ts.Expression[] {
    return this.parseDelimitedNodes(closeSymbol).map((node) => materializeNode(node));
  }

  private parseDelimitedNodes(closeSymbol: string): ParsedNode[] {
    if (this.lookahead.kind === "symbol" && this.lookahead.value === closeSymbol) {
      this.consumeSymbol(closeSymbol);
      return [];
    }

    const expression = this.parseExpression(0);
    this.consumeSymbol(closeSymbol);
    return flattenNodeSequence(expression);
  }

  private parseColonArguments(): ParsedNode {
    this.consume("colon");
    return this.parseExpression(0);
  }

  private consume(kind: Token["kind"]): Token {
    if (this.lookahead.kind !== kind) {
      throw new Error(`Expected ${kind}, got ${describeToken(this.lookahead)} at ${this.lookahead.position}`);
    }
    const token = this.lookahead;
    this.lookahead = nextToken(this.tokenizer);
    return token;
  }

  private consumeSymbol(symbol: string): Token {
    if (this.lookahead.kind !== "symbol" || this.lookahead.value !== symbol) {
      throw new Error(`Expected symbol ${symbol}, got ${describeToken(this.lookahead)} at ${this.lookahead.position}`);
    }
    return this.consume("symbol");
  }

  private consumePairKey(): string {
    if (this.lookahead.kind === "identifier") {
      return this.consume("identifier").value;
    }

    if (this.lookahead.kind === "variable") {
      return stripSigil(this.consume("variable").value);
    }

    throw new Error(`Expected pair key, got ${describeToken(this.lookahead)} at ${this.lookahead.position}`);
  }

  private expect(kind: Token["kind"]): void {
    this.consume(kind);
  }

  private startsImplicitArgumentList(): boolean {
    if (this.lookahead.kind === "number" || this.lookahead.kind === "string" || this.lookahead.kind === "variable") {
      return true;
    }

    if (this.lookahead.kind === "identifier" || this.lookahead.kind === "colon") {
      return true;
    }

    if (this.lookahead.kind !== "symbol") {
      return false;
    }

    return this.lookahead.value === "(" || this.lookahead.value === "[" || this.lookahead.value === "{";
  }

  private isColonAhead(): boolean {
    return this.lookahead.kind === "colon";
  }

  private isSymbolAhead(symbol: string): boolean {
    return this.lookahead.kind === "symbol" && this.lookahead.value === symbol;
  }
}

function createTokenizer(source: string, symbols: readonly string[]): TokenizerState {
  return { source, symbols, index: 0 };
}

function nextToken(state: TokenizerState): Token {
  skipWhitespace(state);

  if (state.index >= state.source.length) {
    return { kind: "eof", value: "", position: state.index };
  }

  const start = state.index;
  const char = state.source[start];

  if (char === ",") {
    state.index += 1;
    return { kind: "comma", value: ",", position: start };
  }

  if (char === ":") {
    state.index += 1;
    return { kind: "colon", value: ":", position: start };
  }

  if (char === "'" || char === "\"") {
    return readStringToken(state, char);
  }

  if (isSigil(char) && isIdentifierStart(state.source[start + 1] ?? "")) {
    state.index += 1;
    state.index = readIdentifier(state.source, state.index);
    return { kind: "variable", value: state.source.slice(start, state.index), position: start };
  }

  if (isAsciiDigit(char)) {
    state.index += 1;
    while (state.index < state.source.length && isAsciiDigit(state.source[state.index])) {
      state.index += 1;
    }
    if (state.source[state.index] === "." && isAsciiDigit(state.source[state.index + 1] ?? "")) {
      state.index += 1;
      while (state.index < state.source.length && isAsciiDigit(state.source[state.index])) {
        state.index += 1;
      }
    }
    return { kind: "number", value: state.source.slice(start, state.index), position: start };
  }

  if (isIdentifierStart(char)) {
    state.index = readIdentifier(state.source, state.index + 1);
    return { kind: "identifier", value: state.source.slice(start, state.index), position: start };
  }

  for (const symbol of state.symbols) {
    if (state.source.startsWith(symbol, start)) {
      state.index += symbol.length;
      return { kind: "symbol", value: symbol, position: start };
    }
  }

  throw new Error(`Unknown token starting at ${start}: ${JSON.stringify(state.source.slice(start, start + 8))}`);
}

function skipWhitespace(state: TokenizerState): void {
  while (state.index < state.source.length && /\s/u.test(state.source[state.index])) {
    state.index += 1;
  }
}

function readStringToken(state: TokenizerState, quote: string): Token {
  const start = state.index;
  state.index += 1;

  let value = "";
  while (state.index < state.source.length) {
    const char = state.source[state.index];
    if (char === quote) {
      state.index += 1;
      return { kind: "string", value, position: start };
    }
    if (char === "\\") {
      const escaped = state.source[state.index + 1];
      if (escaped === undefined) {
        break;
      }
      value += decodeEscape(escaped);
      state.index += 2;
      continue;
    }
    value += char;
    state.index += 1;
  }

  throw new Error(`Unterminated string literal at ${start}`);
}

function readIdentifier(source: string, index: number): number {
  let cursor = index;

  while (cursor < source.length) {
    const char = source[cursor];
    if (isIdentifierPart(char)) {
      cursor += 1;
      continue;
    }
    if ((char === "-" || char === "'") && isIdentifierStart(source[cursor + 1] ?? "")) {
      cursor += 2;
      continue;
    }
    break;
  }

  return cursor;
}

function decodeEscape(value: string): string {
  switch (value) {
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    case "\"":
      return "\"";
    case "'":
      return "'";
    case "\\":
      return "\\";
    default:
      return value;
  }
}

function describeToken(token: Token): string {
  return token.kind === "eof" ? "end of input" : `${token.kind}(${token.value})`;
}

function isAsciiDigit(value: string): boolean {
  return value >= "0" && value <= "9";
}

function isSigil(value: string): boolean {
  return value === "$" || value === "@" || value === "%" || value === "&";
}

function isIdentifierStart(value: string): boolean {
  return /[\p{Alphabetic}_]/u.test(value);
}

function isIdentifierPart(value: string): boolean {
  return /[\p{Alphabetic}\p{Decimal_Number}_]/u.test(value);
}

function stripSigil(value: string): string {
  return value.slice(1);
}

function identifierExpression(name: string): ts.Expression {
  return isTsIdentifier(name) ? ts.factory.createIdentifier(name) : ts.factory.createStringLiteral(name);
}

function isTsIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name);
}

function createNode(expression: ts.Expression, bareword?: string): ParsedNode {
  return { expression, bareword };
}

function createListNode(items: readonly ParsedNode[]): ParsedNode {
  return {
    expression: ts.factory.createArrayLiteralExpression(items.map((item) => materializeNode(item)), false),
    listItems: items,
  };
}

function createPairNode(key: ts.Expression, value: ts.Expression): ParsedNode {
  const pair = { key, value };
  return {
    expression: ts.factory.createObjectLiteralExpression([
      ts.factory.createPropertyAssignment("key", key),
      ts.factory.createPropertyAssignment("value", value),
    ], false),
    pair,
  };
}

function normalizePairKey(node: ParsedNode): ts.Expression {
  if (node.bareword !== undefined) {
    return ts.factory.createStringLiteral(node.bareword);
  }
  return materializeNode(node);
}

function collapseDelimitedValue(expressions: ts.Expression[]): ts.Expression {
  if (expressions.length === 0) {
    return ts.factory.createArrayLiteralExpression([], false);
  }
  if (expressions.length === 1) {
    return expressions[0];
  }
  return ts.factory.createArrayLiteralExpression(expressions, false);
}

function flattenListNodes(node: ParsedNode): ParsedNode[] {
  return node.listItems ? [...node.listItems] : [node];
}

function flattenListItems(node: ParsedNode): ts.Expression[] {
  return flattenListNodes(node).map((item) => materializeNode(item));
}

function flattenNodeSequence(node: ParsedNode): ParsedNode[] {
  return flattenListNodes(node);
}

function materializeNode(node: ParsedNode): ts.Expression {
  return node.listItems
    ? ts.factory.createArrayLiteralExpression(node.listItems.map((item) => materializeNode(item)), false)
    : node.expression;
}

function canImplicitlyCall(node: ParsedNode): boolean {
  const expression = materializeNode(node);
  return ts.isIdentifier(expression) || ts.isCallExpression(expression) || ts.isParenthesizedExpression(expression);
}

function splitNumericPairSuffix(value: string): { key: string; value: string } | undefined {
  const match = value.match(/^(.*?)(\d+)$/u);
  if (!match || match[1].length === 0) {
    return undefined;
  }
  return { key: match[1], value: match[2] };
}

function matchingQuoteCloser(openSymbol: string): string {
  switch (openSymbol) {
    case "<":
      return ">";
    case "<<":
      return ">>";
    case "«":
      return "»";
    default:
      throw new Error(`Unsupported quote opener ${openSymbol}`);
  }
}

function createPropertyFromPair(pair: PairParts): ts.ObjectLiteralElementLike {
  if (ts.isStringLiteral(pair.key) || ts.isNoSubstitutionTemplateLiteral(pair.key)) {
    const text = pair.key.text;
    if (isTsIdentifier(text)) {
      return ts.factory.createPropertyAssignment(ts.factory.createIdentifier(text), pair.value);
    }
    return ts.factory.createPropertyAssignment(ts.factory.createStringLiteral(text), pair.value);
  }

  if (ts.isNumericLiteral(pair.key)) {
    return ts.factory.createPropertyAssignment(ts.factory.createNumericLiteral(pair.key.text), pair.value);
  }

  if (ts.isIdentifier(pair.key)) {
    return ts.factory.createPropertyAssignment(pair.key, pair.value);
  }

  return ts.factory.createPropertyAssignment(ts.factory.createComputedPropertyName(pair.key), pair.value);
}

function assertAssignable(expression: ts.Expression): void {
  if (
    ts.isIdentifier(expression) ||
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    return;
  }

  throw new Error(`Expression ${printDebugExpression(expression)} is not assignable`);
}

function printDebugExpression(expression: ts.Expression): string {
  const printer = ts.createPrinter();
  const sourceFile = ts.createSourceFile("debug.ts", "", ts.ScriptTarget.ESNext, false, ts.ScriptKind.TS);
  return printer.printNode(ts.EmitHint.Expression, expression, sourceFile);
}

export function createBaseScope(): OperatorScope {
  const scope = new OperatorScope();

  scope
    .prefix("-", {
      bindingPower: 70,
      emit: ({ ts: tsLib }, operand) => tsLib.factory.createPrefixUnaryExpression(tsLib.SyntaxKind.MinusToken, operand),
    })
    .prefix("+", {
      bindingPower: 70,
      emit: ({ ts: tsLib }, operand) => tsLib.factory.createPrefixUnaryExpression(tsLib.SyntaxKind.PlusToken, operand),
    })
    .postfix("!", {
      bindingPower: 80,
      emit: ({ ts: tsLib }, operand) => tsLib.factory.createCallExpression(
        tsLib.factory.createIdentifier("factorial"),
        undefined,
        [operand],
      ),
    })
    .infix("**", {
      bindingPower: 60,
      associativity: "right",
      emit: ({ ts: tsLib }, left, right) => tsLib.factory.createBinaryExpression(
        left,
        tsLib.factory.createToken(tsLib.SyntaxKind.AsteriskAsteriskToken),
        right,
      ),
    })
    .infix("*", {
      bindingPower: 50,
      emit: ({ ts: tsLib }, left, right) => tsLib.factory.createBinaryExpression(
        left,
        tsLib.factory.createToken(tsLib.SyntaxKind.AsteriskToken),
        right,
      ),
    })
    .infix("/", {
      bindingPower: 50,
      emit: ({ ts: tsLib }, left, right) => tsLib.factory.createBinaryExpression(
        left,
        tsLib.factory.createToken(tsLib.SyntaxKind.SlashToken),
        right,
      ),
    })
    .infix("+", {
      bindingPower: 40,
      emit: ({ ts: tsLib }, left, right) => tsLib.factory.createBinaryExpression(
        left,
        tsLib.factory.createToken(tsLib.SyntaxKind.PlusToken),
        right,
      ),
    })
    .infix("-", {
      bindingPower: 40,
      emit: ({ ts: tsLib }, left, right) => tsLib.factory.createBinaryExpression(
        left,
        tsLib.factory.createToken(tsLib.SyntaxKind.MinusToken),
        right,
      ),
    })
    .infix("=>", {
      bindingPower: 10,
      associativity: "right",
      emit: (_context, left, right) => ts.factory.createObjectLiteralExpression([
        ts.factory.createPropertyAssignment("key", left),
        ts.factory.createPropertyAssignment("value", right),
      ], false),
    })
    .infix("=", {
      bindingPower: 5,
      associativity: "right",
      emit: ({ ts: tsLib }, left, right) => tsLib.factory.createBinaryExpression(
        left,
        tsLib.factory.createToken(tsLib.SyntaxKind.EqualsToken),
        right,
      ),
    })
    .circumfix("(", ")", {
      emit: (_context, expressions) => {
        if (expressions.length !== 1) {
          throw new Error(`Grouping circumfix expects exactly one expression, received ${expressions.length}`);
        }
        return ts.factory.createParenthesizedExpression(expressions[0]);
      },
    })
    .postcircumfix("(", ")", {
      bindingPower: 90,
      emit: ({ ts: tsLib }, target, expressions) =>
        tsLib.factory.createCallExpression(target, undefined, expressions),
    })
    .postcircumfix("[", "]", {
      bindingPower: 90,
      emit: ({ ts: tsLib }, target, expressions) => {
        if (expressions.length !== 1) {
          throw new Error(`Index postcircumfix expects exactly one expression, received ${expressions.length}`);
        }
        return tsLib.factory.createElementAccessExpression(target, expressions[0]);
      },
    });

  return scope;
}
