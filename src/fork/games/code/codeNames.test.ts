import { describe, expect, it } from "vitest";
import { javascriptLanguage } from "@codemirror/lang-javascript";
import { pythonLanguage } from "@codemirror/lang-python";
import { nameWarnings, testCallNames } from "./codeNames";
import { BUILTIN_DRILLS } from "./codeDrills";
import type { DrillTest } from "./codeModel";

function javascript(code: string, testNames: string[] = []) {
  return nameWarnings(
    "javascript",
    code,
    javascriptLanguage.parser.parse(code),
    testNames,
  );
}

function python(code: string, testNames: string[] = []) {
  return nameWarnings(
    "python",
    code,
    pythonLanguage.parser.parse(code),
    testNames,
  );
}

describe("JavaScript names", () => {
  it("flags a typo and suggests the close definition", () => {
    const warnings = javascript("let total = 1;\nconsole.log(totl);\n");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      name: "totl",
      suggestion: "total",
    });
    expect(warnings[0].message).toBe(
      "`totl` isn't defined. Did you mean `total`?",
    );
  });

  it("leaves globals, properties, keys, bindings and hoisted functions alone", () => {
    const code = `
add(1, 2);

let arr = [1, 2];
const obj = { key: 1 };

function add(a, b) {
  return a + b;
}

function destructured({ a }, ...rest) {
  return a + rest.length;
}

const arrow = (value = 1, ...extra) => value + extra.length;

try {
  add(1, 2);
} catch (e) {
  console.log(e);
}

for (const x of arr) {
  console.log(x);
}

console.log(Math.max(arr.length, 1), obj.prop, obj.key, { key: 1 });
`;
    expect(javascript(code)).toEqual([]);
  });

  it("knows the everyday globals", () => {
    expect(javascript("console.log(Math.max(1, 2), JSON.stringify({}));\n")).toEqual(
      [],
    );
  });
});

describe("Python names", () => {
  it("flags a NameError-style typo and suggests the close definition", () => {
    const warnings = python("total = 1\nprint(totl)\n");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      name: "totl",
      suggestion: "total",
    });
    expect(warnings[0].message).toBe(
      "`totl` isn't defined. Did you mean `total`?",
    );
  });

  it("leaves builtins, params, targets, imports and match captures alone", () => {
    const code = `
import math
from collections import Counter as C

count = 0
xs = [1, 2, 3]
p = "x"

def f(key):
    return key

def outer():
    total = 0

    def inner():
        nonlocal total
        total += 1
        return total

    return inner

app = object()

@app.route("/")
def decorated():
    pass

class Thing:
    def method(self, *args, **kwargs):
        global count
        with open(p) as fh:
            data = fh.read()
        try:
            for i, x in enumerate(xs):
                print(i, x)
        except ValueError as err:
            print(err)
        values = [n for n in xs]
        mapping = {k: v for k, v in enumerate(xs)}
        unique = {n for n in xs}
        gen = (n for n in xs)
        summed = sum(n for n in xs)
        fn = lambda x: x
        return (
            len(range(3)),
            sorted(zip(values, unique)),
            print,
            ValueError,
            self.x,
            f(key=1),
            math.pi,
            C,
            fn(gen),
            data,
            args,
            kwargs,
            mapping,
            count,
        )

thing = Thing()
print(thing, outer())
`;
    expect(python(code)).toEqual([]);
  });

  it("understands match capture names", () => {
    const code = `class Point:
  pass
value = 1
match value:
  case {"a": a, "b": b} if a > 0:
    pass
  case [first, *rest]:
    pass
  case Point(x=px, y=py):
    pass
  case other:
    pass
`;
    expect(python(code)).toEqual([]);
  });

  it("counts a test's leading call name once", () => {
    const tests: DrillTest[] = [
      { call: "add(1, 2)", expect: "3" },
      { call: "add(3, 4)", expect: "7" },
      { call: 'shout("hey")', expect: '"HEY!"' },
    ];
    expect(testCallNames(tests)).toEqual(["add", "shout"]);
  });

  it("warns when the tests call a name the code does not define", () => {
    const tests = [{ call: "add(1, 2)", expect: "3" }];
    const warnings = python(
      "def Add(a, b):\n    return a + b\n",
      testCallNames(tests),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      from: 0,
      name: "add",
      suggestion: "Add",
    });
    expect(warnings[0].message).toBe(
      "The tests call `add`, but your code doesn't define it. Did you mean `Add`?",
    );
  });

  it("does not warn when the code defines the test's name", () => {
    const tests = [{ call: "add(1, 2)", expect: "3" }];
    expect(
      python("def add(a, b):\n    return a + b\n", testCallNames(tests)),
    ).toEqual([]);
  });
});

describe("built-in drills", () => {
  it("keeps every solution free of name warnings", () => {
    for (const drill of BUILTIN_DRILLS) {
      const tree =
        drill.language === "python"
          ? pythonLanguage.parser.parse(drill.solution)
          : javascriptLanguage.parser.parse(drill.solution);
      expect(
        nameWarnings(
          drill.language,
          drill.solution,
          tree,
          testCallNames(drill.tests),
        ),
        drill.id,
      ).toEqual([]);
    }
  });
});

describe("name checks that are skipped", () => {
  it("returns nothing while the tree has a syntax error", () => {
    expect(javascript("function add(a, b) {\n  return totl;\n", ["add"])).toEqual(
      [],
    );
    expect(python("def add(a, b):\n    return a + b +\n", ["add"])).toEqual([]);
  });

  it("returns nothing for a document over 20k characters", () => {
    const code = `const total = 1;\n${"// a longer drill\n".repeat(2000)}console.log(totl);\n`;
    expect(javascript(code)).toEqual([]);
  });
});

describe("review fixes", () => {
  it("knows the other standard globals", () => {
    const src = "const s = new WeakSet(); Reflect.ownKeys({}); new Uint8Array(2); throw new SyntaxError('x');";
    expect(nameWarnings("javascript", src, javascriptLanguage.parser.parse(src))).toEqual([]);
  });
  it("doesn't count a label as a variable", () => {
    const src = "outer: { break outer; } console.log(outer);";
    expect(nameWarnings("javascript", src, javascriptLanguage.parser.parse(src)).map((w) => w.name)).toEqual(["outer"]);
  });
});
