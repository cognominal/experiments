import Std

/-!
This file is a heavily commented replica of
`leanprover/lean4`'s `doc/BoolExpr.lean` from the `cade2021` branch.

The goal here is not to be minimal. The goal is to explain what each part
is doing to a total Lean beginner who knows a bit of basic logic and Haskell.

If you know Haskell, a useful rough mental model is:

* `inductive` is how we define an algebraic data type.
* `def` is how we define a function.
* `match` is pattern matching.
* `theorem` is a definition whose value is a proof.
* `namespace` is a way to group names.

Lean is also a theorem prover, so later in the file we prove that our
"simplifier" does not change the meaning of a boolean expression.
-/

open Std
open Lean

/-!
`BoolExpr` is the syntax tree of a tiny boolean-expression language.

Think of it as an AST with four constructors:

* a variable, such as `"p"`
* a literal boolean value, such as `true`
* `or`
* `not`

In Haskell-ish notation, this is close to:

```haskell
data BoolExpr
  = Var String
  | Val Bool
  | Or BoolExpr BoolExpr
  | Not BoolExpr
```
-/
inductive BoolExpr where
  | var (name : String)
  | val (b : Bool)
  | or  (p q : BoolExpr)
  | not (p : BoolExpr)
  deriving Repr, BEq, DecidableEq

/-!
`deriving ...` asks Lean to generate some useful boilerplate:

* `Repr` lets Lean print values in debugging output.
* `BEq` gives a boolean equality test.
* `DecidableEq` gives a proof-producing notion of equality decision.

That last one matters later because Lean often wants to know whether equality
between two values can be mechanically decided.
-/

/-!
This function asks whether an expression is already a literal value.

Only `val _` counts as a value here.
Everything else is a non-trivial expression.

The type

```lean
BoolExpr -> Bool
```

means: given a boolean expression, compute a boolean answer.
-/
def BoolExpr.isValue : BoolExpr → Bool
  | val _ => true
  | _     => false

/-!
`Inhabited` means "this type has a default value".

This is sometimes convenient for generic code. Here we pick `false` as the
default boolean expression.
-/
instance : Inhabited BoolExpr where
  default := BoolExpr.val false

namespace BoolExpr

/-!
Inside this namespace, names like `var`, `val`, `or`, and `not`
can be used without writing `BoolExpr.` in front every time.
-/

/-!
The original file explicitly derives `DecidableEq` again inside the namespace.
This is harmless and mirrors the upstream example.
-/
deriving instance DecidableEq for BoolExpr

/-!
`#eval` runs code immediately and shows the result.

`decide` turns a proposition with a decision procedure into `true` or `false`.
So this line checks whether `true = false` as wrapped inside `BoolExpr.val`.
-/
#eval decide (BoolExpr.val true = BoolExpr.val false)

/-!
`#check` asks Lean to tell us the type of an expression.

Here it shows that equality on `BoolExpr` is decidable.
-/
#check (a b : BoolExpr) → Decidable (a = b)

/-!
A `Context` says which boolean value each variable name should have.

`AssocList String Bool` is just a simple association list mapping variable
names to boolean values.
-/
abbrev Context := AssocList String Bool

/-!
`denote` gives meaning to syntax.

It evaluates a `BoolExpr` into an actual Lean `Bool`, using a context to look
up variables.

This is a classic "interpreter for a small language".
-/
def denote (ctx : Context) : BoolExpr → Bool
  | BoolExpr.or p q => denote ctx p || denote ctx q
  | BoolExpr.not p  => !denote ctx p
  | BoolExpr.val b  => b
  | BoolExpr.var x  =>
      if let some b := ctx.find? x then
        b
      else
        false

/-!
If a variable is missing from the context, this interpreter treats it as
`false`. That choice is not logically forced; it is just the convention used
in the example.
-/

/-!
`simplify` performs a few basic simplifications:

* recursively simplify subexpressions first
* replace `p or true` with `true`
* replace `p or false` with `p`
* replace `not true` with `false`
* replace `not false` with `true`

The interesting part is the `where` block: it defines helper functions that are
local to `simplify`.
-/
def simplify : BoolExpr → BoolExpr
  | or p q => mkOr (simplify p) (simplify q)
  | not p  => mkNot (simplify p)
  | e      => e
where
  /-!
  `mkOr` is a smart constructor for `or`.

  Instead of blindly building `or p q`, it notices easy cases where the answer
  can be simplified immediately.
  -/
  mkOr : BoolExpr → BoolExpr → BoolExpr
    | p, val true   => val true
    | p, val false  => p
    | val true, p   => val true
    | val false, p  => p
    | p, q          => or p q

  /-!
  `mkNot` is the analogous smart constructor for negation.
  -/
  mkNot : BoolExpr → BoolExpr
    | val b => val (!b)
    | p     => not p

/-!
The next few theorems are tiny facts that Lean can use automatically during
proof simplification.

`@[simp]` marks them as rewrite rules for the `simp` tactic.

Most of these theorems are proved by `rfl`, short for "reflexivity".
That works when both sides reduce to exactly the same thing by unfolding
definitions.
-/
@[simp] theorem denote_not_Eq (ctx : Context) (p : BoolExpr) :
    denote ctx (not p) = !denote ctx p := rfl

@[simp] theorem denote_or_Eq (ctx : Context) (p q : BoolExpr) :
    denote ctx (or p q) = (denote ctx p || denote ctx q) := rfl

@[simp] theorem denote_val_Eq (ctx : Context) (b : Bool) :
    denote ctx (val b) = b := rfl

/-!
This says that the meaning of `mkNot p` is the same as the meaning of `not p`.

Proof idea:
do a case split on `p`.

`cases p` means: consider each constructor of `BoolExpr`.
In each branch, the statement becomes trivial.
-/
@[simp] theorem denote_mkNot_Eq (ctx : Context) (p : BoolExpr) :
    denote ctx (simplify.mkNot p) = denote ctx (not p) := by
  cases p <;> rfl

/-!
The next four lemmas just record what `mkOr` does on easy inputs.

Again, the proofs are by cases because `mkOr` itself is defined by pattern
matching.
-/
@[simp] theorem mkOr_p_true (p : BoolExpr) :
    simplify.mkOr p (val true) = val true := by
  cases p with
  | val x => cases x <;> rfl
  | _     => rfl

@[simp] theorem mkOr_p_false (p : BoolExpr) :
    simplify.mkOr p (val false) = p := by
  cases p with
  | val x => cases x <;> rfl
  | _     => rfl

@[simp] theorem mkOr_true_p (p : BoolExpr) :
    simplify.mkOr (val true) p = val true := by
  cases p with
  | val x => cases x <;> rfl
  | _     => rfl

@[simp] theorem mkOr_false_p (p : BoolExpr) :
    simplify.mkOr (val false) p = p := by
  cases p with
  | val x => cases x <;> rfl
  | _     => rfl

/-!
This is the analogous semantic correctness theorem for `mkOr`.

The statement says:

* interpreting the smart constructor result
* gives the same boolean answer as
* interpreting a plain `or`

The proof is a larger case split on both `p` and `q`.
-/
@[simp] theorem denote_mkOr (ctx : Context) (p q : BoolExpr) :
    denote ctx (simplify.mkOr p q) = denote ctx (or p q) := by
  cases p with
  | val x =>
      cases q with
      | val y => cases x <;> cases y <;> simp
      | _     => cases x <;> simp
  | _ =>
      cases q with
      | val y => cases y <;> simp
      | _     => rfl

/-!
These two lemmas just expose what `simplify` does on `not` and `or`.
They are both definitional equalities, so `rfl` is enough.
-/
@[simp] theorem simplify_not (p : BoolExpr) :
    simplify (not p) = simplify.mkNot (simplify p) := rfl

@[simp] theorem simplify_or (p q : BoolExpr) :
    simplify (or p q) = simplify.mkOr (simplify p) (simplify q) := rfl

/-!
This is the main theorem of the file.

It says simplification preserves meaning.

In plain English:

* first simplify the expression, then interpret it
* or interpret the original expression directly

you get the same answer either way.

The proof uses structural induction on the expression `b`.

If you know Haskell, you can think of this as "proof by recursion on the AST".
Each recursive case gets induction hypotheses (`ih`, `ih₁`, `ih₂`) telling us
that the theorem already holds for the smaller subexpressions.
-/
def denote_simplify_eq (ctx : Context) (b : BoolExpr) :
    denote ctx (simplify b) = denote ctx b := by
  induction b with
  | or p q ih₁ ih₂ => simp [ih₁, ih₂]
  | not p ih       => simp [ih]
  | _              => rfl

/-!
The rest of the file defines a tiny domain-specific notation.

This line introduces syntax of the form

```lean
`[BExpr| ... ]
```

which lets us write boolean expressions in a nicer surface form.
-/
syntax "`[BExpr|" term "]" : term

/-!
`macro_rules` translates the nice syntax into ordinary constructors.

For example:

* `` `[BExpr| true] `` becomes `val true`
* `` `[BExpr| p ∨ q] `` becomes `or ... ...`

This is syntax translation only. It does not change the semantics.
-/
macro_rules
  | `(`[BExpr| true])     => `(val true)
  | `(`[BExpr| false])    => `(val false)
  | `(`[BExpr| $x:ident]) => `(var $(quote x.getId.toString))
  | `(`[BExpr| $p ∨ $q])  => `(or `[BExpr| $p] `[BExpr| $q])
  | `(`[BExpr| ¬ $p])     => `(not `[BExpr| $p])

/-!
Lean accepts the notation and tells us its type.
-/
#check `[BExpr| ¬ p ∨ q]

/-!
Now we define a second bit of syntax for writing contexts and evaluation in a
compact way.

An `entry` looks like `b ↦ true`.
-/
syntax entry := ident " ↦ " term:max
syntax entry,* "⊢" term : term

/-!
This macro turns

```lean
a ↦ false, b ↦ true ⊢ b ∨ a
```

into a call to `denote` with an association list context, and it parses the
expression on the right using our `[BExpr| ...]` notation.
-/
macro_rules
  | `( $[$xs:ident ↦ $vs:term],* ⊢ $p:term ) =>
      let xs := xs.map fun x => quote x.getId.toString
      `(denote (List.toAssocList [$[( $xs , $vs )],*]) `[BExpr| $p])

/-!
More sanity checks and examples.
-/
#check b ↦ true ⊢ b ∨ b
#eval  a ↦ false, b ↦ false ⊢ b ∨ a

end BoolExpr
