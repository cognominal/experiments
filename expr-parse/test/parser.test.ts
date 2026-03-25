import { describe, expect, test } from "bun:test";
import { createBaseScope, parseExpression } from "../src/index";

function print(source: string, configure?: (scope: ReturnType<typeof createBaseScope>) => void): string {
  const scope = createBaseScope();
  configure?.(scope);
  return parseExpression(source, scope).print();
}

describe("Pratt parser DSL", () => {
  test("respects infix precedence", () => {
    expect(print("1 + 2 * 3")).toBe("1 + 2 * 3");
  });

  test("respects right associativity", () => {
    expect(print("2 ** 3 ** 4")).toBe("2 ** 3 ** 4");
  });

  test("supports prefix operators", () => {
    expect(print("-a + b")).toBe("-a + b");
  });

  test("supports circumfix grouping", () => {
    expect(print("(1 + 2) * 3")).toBe("(1 + 2) * 3");
  });

  test("supports postcircumfix call and indexing", () => {
    expect(print("lookup(a, b)[0]")).toBe("lookup(a, b)[0]");
  });

  test("supports raku-style list construction with comma", () => {
    expect(print("1, 2, 3")).toBe("[1, 2, 3]");
    expect(print("1 + 2, 3 * 4")).toBe("[1 + 2, 3 * 4]");
  });

  test("treats parentheses as an idempotent circumfix", () => {
    expect(print("(1 + 2) * 3")).toBe("(1 + 2) * 3");
    expect(print("(1, 2, 3)")).toBe("[1, 2, 3]");
    expect(print("()")).toBe("[]");
  });

  test("supports implicit-argument function calls", () => {
    expect(print("say 42")).toBe("say(42)");
    expect(print("say 1, 2 + 3")).toBe("say(1, 2 + 3)");
    expect(print("map (1, 2, 3)")).toBe("map(1, 2, 3)");
  });

  test("supports property access", () => {
    expect(print("record.value")).toBe("record.value");
    expect(print("record.inner.value")).toBe("record.inner.value");
    expect(print("record.items[0].name")).toBe("record.items[0].name");
  });

  test("supports raku-style method calls", () => {
    expect(print("record.value: 42")).toBe("record.value(42)");
    expect(print("record.value(42)")).toBe("record.value(42)");
    expect(print(".trim")).toBe("$_.trim()");
    expect(print(".substr(1, 2)")).toBe("$_.substr(1, 2)");
    expect(print(".join: ', '")).toBe('$_.join(", ")');
  });

  test("supports assignment to identifiers, properties, and elements", () => {
    expect(print("answer = 42")).toBe("answer = 42");
    expect(print("record.value = 42")).toBe("record.value = 42");
    expect(print("items[0] = next")).toBe("items[0] = next");
    expect(print("record.items[0].name = value")).toBe("record.items[0].name = value");
  });

  test("supports right-associative chained assignment", () => {
    expect(print("a = b = c")).toBe("a = b = c");
  });

  test("supports arrow pairs with bare identifiers, strings, and expressions", () => {
    expect(print("key => 42")).toBe('{ key: "key", value: 42 }');
    expect(print('"name" => 42')).toBe('{ key: "name", value: 42 }');
    expect(print("(a + b) => 1")).toBe('{ key: (a + b), value: 1 }');
    expect(print("like-an-identifier-ain't-it => 42")).toBe('{ key: "like-an-identifier-ain\'t-it", value: 42 }');
  });

  test("supports short-form colon pairs", () => {
    expect(print(":thing")).toBe('{ key: "thing", value: true }');
    expect(print(":!thing")).toBe('{ key: "thing", value: false }');
    expect(print(":$thing")).toBe('{ key: "thing", value: thing }');
    expect(print(":@elements")).toBe('{ key: "elements", value: elements }');
    expect(print(":%hash")).toBe('{ key: "hash", value: hash }');
    expect(print(":&callback")).toBe('{ key: "callback", value: callback }');
    expect(print(":42 thing")).toBe('{ key: "thing", value: 42 }');
    expect(print(":answer42")).toBe('{ key: "answer", value: 42 }');
  });

  test("supports explicit-value colon pairs", () => {
    expect(print(":thing(value + 1)")).toBe('{ key: "thing", value: value + 1 }');
    expect(print(":thing<quoted>")).toBe('{ key: "thing", value: "quoted" }');
    expect(print(":thing<quoted list>")).toBe('{ key: "thing", value: ["quoted", "list"] }');
    expect(print(":thing['some', 'values']")).toBe('{ key: "thing", value: ["some", "values"] }');
    expect(print(":thing{a => 'b'}")).toBe('{ key: "thing", value: { a: "b" } }');
  });

  test("supports scoped shadowing for symbols", () => {
    const parentScope = createBaseScope();
    const childScope = parentScope.child();
    childScope.infix("+", {
      bindingPower: 40,
      emit: ({ ts: tsLib }, left, right) =>
        tsLib.factory.createBinaryExpression(
          left,
          tsLib.factory.createToken(tsLib.SyntaxKind.AsteriskToken),
          right,
        ),
    });

    expect(parseExpression("2 + 3", parentScope).print()).toBe("2 + 3");
    expect(parseExpression("2 + 3", childScope).print()).toBe("2 * 3");
  });

  test("supports custom scoped circumfix symbols", () => {
    const scope = createBaseScope().child();

    scope.circumfix("<", ">", {
      emit: ({ ts: tsLib }, expressions) =>
        tsLib.factory.createArrayLiteralExpression(expressions, false),
    });

    expect(parseExpression("<1, 2 + 3>", scope).print()).toBe("[1, 2 + 3]");
  });

  test("supports custom scoped postcircumfix symbols", () => {
    const scope = createBaseScope().child();

    scope.postcircumfix("{", "}", {
      bindingPower: 90,
      emit: ({ ts: tsLib }, target, expressions) => {
        if (expressions.length !== 1) {
          throw new Error("Brace access expects exactly one key");
        }

        return tsLib.factory.createCallExpression(
          tsLib.factory.createIdentifier("pick"),
          undefined,
          [target, expressions[0]],
        );
      },
    });

    expect(parseExpression("record{foo + 1}", scope).print()).toBe("pick(record, foo + 1)");
  });

  test("rejects non-assignable assignment targets", () => {
    expect(() => print("a + b = c")).toThrow("is not assignable");
  });
});
