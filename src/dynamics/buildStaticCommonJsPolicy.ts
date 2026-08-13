import ts from "typescript";

import type { StaticClosurePolicy } from "./buildStaticPolicy.js";

const has = (values: readonly string[], value: string): boolean => values.includes(value);

export interface PinnedCommonJsInitializers {
  readonly declarations: ReadonlySet<ts.Identifier>;
  readonly getOwnPropNames: ReadonlySet<ts.Identifier>;
  readonly requireDefinitions: ReadonlySet<ts.Identifier>;
}

const isIdentifierNamed = (node: ts.Node | undefined, name: string): node is ts.Identifier =>
  node !== undefined && ts.isIdentifier(node) && node.text === name;

const isCleanIdentifierBinding = (binding: ts.ParameterDeclaration | ts.VariableDeclaration, name: string): boolean =>
  isIdentifierNamed(binding.name, name)
  && (!ts.isVariableDeclaration(binding) || binding.exclamationToken === undefined)
  && binding.type === undefined
  && binding.initializer === undefined;

const isCleanIdentifierParameter = (parameter: ts.ParameterDeclaration, name: string): boolean =>
  isCleanIdentifierBinding(parameter, name)
  && parameter.dotDotDotToken === undefined
  && parameter.questionToken === undefined
  && parameter.modifiers === undefined;

const isPlainTopLevelVarDeclaration = (declaration: ts.VariableDeclaration): boolean => {
  const list = declaration.parent;
  const statement = list.parent;
  return ts.isVariableDeclarationList(list)
    && list.declarations.length === 1
    && (list.flags & ts.NodeFlags.BlockScoped) === 0
    && ts.isVariableStatement(statement)
    && statement.modifiers === undefined
    && ts.isSourceFile(statement.parent);
};

const hasCleanParameters = (parameters: readonly ts.ParameterDeclaration[], names: readonly string[]): boolean =>
  parameters.length === names.length && parameters.every((parameter, index) =>
    isCleanIdentifierParameter(parameter, names[index] as string));

const isUnmodifiedFunction = (functionLike: ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration): boolean =>
  ts.getModifiers(functionLike)?.length === undefined && functionLike.typeParameters === undefined;

const unwrapComposedExpression = (expression: ts.Expression): ts.Expression => {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const flattenCommaExpression = (expression: ts.Expression): ts.Expression[] => {
  const unwrapped = unwrapComposedExpression(expression);
  const parts: ts.Expression[] = [];
  const visit = (candidate: ts.Expression): void => {
    const current = unwrapComposedExpression(candidate);
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      visit(current.left);
      visit(current.right);
    } else {
      parts.push(current);
    }
  };
  visit(unwrapped);
  return parts;
};

const isNumericZero = (expression: ts.Expression): boolean => ts.isNumericLiteral(expression) && expression.text === "0";

const isObjectExportsLiteral = (expression: ts.ObjectLiteralExpression): boolean => {
  if (expression.properties.length !== 1) return false;
  const [property] = expression.properties;
  return ts.isPropertyAssignment(property)
    && isIdentifierNamed(property.name, "exports")
    && ts.isObjectLiteralExpression(property.initializer)
    && property.initializer.properties.length === 0;
};

const isCommonJsModuleFactory = (method: ts.MethodDeclaration): boolean => {
  if (method.parameters.length < 1 || method.parameters.length > 2) return false;
  if (method.asteriskToken !== undefined || method.questionToken !== undefined || method.name === undefined || ts.isComputedPropertyName(method.name)) return false;
  if (!isUnmodifiedFunction(method)) return false;
  return hasCleanParameters(method.parameters, method.parameters.length === 1 ? ["exports"] : ["exports", "module"]);
};

export const isCommonJsInitializerArgument = (expression: ts.Expression): boolean => {
  if (!ts.isObjectLiteralExpression(expression) || expression.properties.length !== 1) return false;
  const [entry] = expression.properties;
  return ts.isMethodDeclaration(entry) && isCommonJsModuleFactory(entry);
};

const isPinnedCommonJsResolverCallee = (expression: ts.Expression): ts.Identifier | undefined => {
  const operands = flattenCommaExpression(unwrapComposedExpression(expression));
  if (operands.length !== 2 || !isNumericZero(operands[0])) return undefined;
  const element = operands[1];
  if (!ts.isElementAccessExpression(element) || element.questionDotToken !== undefined || !isIdentifierNamed(element.expression, "cb")) return undefined;
  if (!ts.isElementAccessExpression(element.argumentExpression) || element.argumentExpression.questionDotToken !== undefined) return undefined;
  const call = element.argumentExpression.expression;
  const index = element.argumentExpression.argumentExpression;
  if (!ts.isCallExpression(call) || call.arguments.length !== 1) return undefined;
  if (call.typeArguments !== undefined || call.questionDotToken !== undefined) return undefined;
  if (!isIdentifierNamed(call.expression, "__getOwnPropNames")) return undefined;
  return isIdentifierNamed(call.arguments[0], "cb") && isNumericZero(index) ? call.expression : undefined;
};

const isPinnedCommonJsResolverCall = (expression: ts.Expression): ts.Identifier | undefined => {
  const unwrapped = unwrapComposedExpression(expression);
  if (!ts.isCallExpression(unwrapped)) return undefined;
  if (unwrapped.typeArguments !== undefined || unwrapped.questionDotToken !== undefined) return undefined;
  if (unwrapped.arguments.length !== 2 || !isInitializedModExports(unwrapped.arguments[0]) || !isIdentifierNamed(unwrapped.arguments[1], "mod")) return undefined;
  return isPinnedCommonJsResolverCallee(unwrapComposedExpression(unwrapped.expression));
};

const isModExports = (expression: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(expression)
  && expression.questionDotToken === undefined
  && isIdentifierNamed(expression.expression, "mod")
  && isIdentifierNamed(expression.name, "exports");

const isInitializedModExports = (expression: ts.Expression): boolean => {
  if (!ts.isPropertyAccessExpression(expression) || expression.questionDotToken !== undefined || !isIdentifierNamed(expression.name, "exports")) return false;
  const assigned = unwrapComposedExpression(expression.expression);
  return ts.isBinaryExpression(assigned)
    && assigned.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && isIdentifierNamed(assigned.left, "mod")
    && ts.isObjectLiteralExpression(assigned.right)
    && isObjectExportsLiteral(assigned.right);
};

const isPinnedCommonJsInitializerReturn = (
  expression: ts.Expression | undefined
): ts.Identifier | undefined => {
  if (expression === undefined) return undefined;
  const parts = flattenCommaExpression(expression);
  if (parts.length !== 2) return undefined;
  const [resolverPart, terminalPart] = parts;
  if (!isModExports(terminalPart)) return undefined;
  if (!ts.isBinaryExpression(resolverPart)) return undefined;
  if (resolverPart.operatorToken.kind !== ts.SyntaxKind.BarBarToken) return undefined;
  if (!isIdentifierNamed(resolverPart.left, "mod")) return undefined;
  return isPinnedCommonJsResolverCall(resolverPart.right);
};

const isPinnedCommonJsInitializerCatch = (clause: ts.CatchClause | undefined): boolean => {
  if (clause === undefined || clause.variableDeclaration === undefined || !isCleanIdentifierBinding(clause.variableDeclaration, "e")) return false;
  if (clause.block.statements.length !== 1 || !ts.isThrowStatement(clause.block.statements[0])) return false;
  const thrown = flattenCommaExpression(clause.block.statements[0].expression);
  return (
    thrown.length === 2
    && isIdentifierNamed(thrown[1], "e")
    && ts.isBinaryExpression(thrown[0])
    && thrown[0].operatorToken.kind === ts.SyntaxKind.EqualsToken
    && isIdentifierNamed(thrown[0].left, "mod")
    && isNumericZero(thrown[0].right)
  );
};

const isGetOwnPropNamesDeclaration = (declaration: ts.Node): ts.Identifier | undefined => {
  if (!ts.isVariableDeclaration(declaration)) return undefined;
  if (!isIdentifierNamed(declaration.name, "__getOwnPropNames")) return undefined;
  if (declaration.exclamationToken !== undefined || declaration.type !== undefined || declaration.initializer === undefined || !ts.isPropertyAccessExpression(declaration.initializer)) return undefined;
  if (!isPlainTopLevelVarDeclaration(declaration)) return undefined;
  if (declaration.initializer.questionDotToken !== undefined) return undefined;
  if (!isIdentifierNamed(declaration.initializer.expression, "Object")) return undefined;
  return declaration.initializer.name.text === "getOwnPropertyNames" ? declaration.name : undefined;
};

const pinnedCopyPropsReference = (node: ts.Node): ts.Identifier | undefined => {
  if (!ts.isCallExpression(node) || node.typeArguments !== undefined || node.questionDotToken !== undefined
    || !isIdentifierNamed(node.expression, "__getOwnPropNames") || node.arguments.length !== 1
    || !isIdentifierNamed(node.arguments[0], "from")) return undefined;
  const loop = node.parent;
  const block = loop.parent;
  const guard = block.parent;
  const guardedBlock = guard.parent;
  const arrow = guardedBlock.parent;
  const declaration = arrow.parent;
  if (!ts.isForOfStatement(loop) || loop.expression !== node || !ts.isBlock(block) || block.statements.length !== 1
    || !ts.isIfStatement(guard) || guard.thenStatement !== block || !ts.isBlock(guardedBlock)
    || !ts.isArrowFunction(arrow) || arrow.body !== guardedBlock || !ts.isVariableDeclaration(declaration)
    || !isPlainTopLevelVarDeclaration(declaration) || !isIdentifierNamed(declaration.name, "__copyProps")
    || declaration.initializer !== arrow || !isUnmodifiedFunction(arrow)
    || !hasCleanParameters(arrow.parameters, ["to", "from", "except", "desc"])) return undefined;
  return node.expression;
};

const pinnedEsmReference = (node: ts.Node): ts.Identifier | undefined => {
  if (!ts.isCallExpression(node) || node.typeArguments !== undefined || node.questionDotToken !== undefined
    || !isIdentifierNamed(node.expression, "__getOwnPropNames") || node.arguments.length !== 1
    || !isIdentifierNamed(node.arguments[0], "fn") || !ts.isElementAccessExpression(node.parent)
    || node.parent.expression !== node || !isNumericZero(node.parent.argumentExpression)
    || !ts.isElementAccessExpression(node.parent.parent) || node.parent.parent.argumentExpression !== node.parent
    || !isIdentifierNamed(node.parent.parent.expression, "fn")) return undefined;
  let current: ts.Node | undefined = node.parent.parent;
  while (current !== undefined && (!ts.isVariableDeclaration(current) || !isPlainTopLevelVarDeclaration(current))) current = current.parent;
  if (current === undefined || !ts.isVariableDeclaration(current)) return undefined;
  if (!isIdentifierNamed(current.name, "__esm") || current.initializer === undefined || !ts.isArrowFunction(current.initializer)) return undefined;
  if (!isUnmodifiedFunction(current.initializer)
    || !hasCleanParameters(current.initializer.parameters, ["fn", "res", "err"])
    || !ts.isFunctionExpression(current.initializer.body) || current.initializer.body.asteriskToken !== undefined
    || !isIdentifierNamed(current.initializer.body.name, "__init") || !hasCleanParameters(current.initializer.body.parameters, [])) return undefined;
  if (!isUnmodifiedFunction(current.initializer.body)) return undefined;
  return node.expression;
};

const isCommonJsInitializerDefinition = (
  declaration: ts.VariableDeclaration,
  policy: StaticClosurePolicy
): ts.Identifier | undefined => {
  if (!isPlainTopLevelVarDeclaration(declaration)) return undefined;
  if (!ts.isIdentifier(declaration.name)) return undefined;
  const declarationName = declaration.name.text;
  if (declarationName !== "__commonJS" && !has(policy.emitted.commonJsInitializerIdentifiers, declarationName)) return undefined;
  if (declaration.exclamationToken !== undefined || declaration.type !== undefined || declaration.initializer === undefined || !ts.isArrowFunction(declaration.initializer)) {
    return undefined;
  }
  if (!isUnmodifiedFunction(declaration.initializer) || !hasCleanParameters(declaration.initializer.parameters, ["cb", "mod"])) {
    return undefined;
  }
  if (!ts.isFunctionExpression(declaration.initializer.body)) return undefined;
  if (!isUnmodifiedFunction(declaration.initializer.body) || declaration.initializer.body.asteriskToken !== undefined
    || !isIdentifierNamed(declaration.initializer.body.name, "__require") || !hasCleanParameters(declaration.initializer.body.parameters, [])) return undefined;

  if (!ts.isBlock(declaration.initializer.body.body) || declaration.initializer.body.body.statements.length !== 1) return undefined;
  const tryStatement = declaration.initializer.body.body.statements[0];
  if (!ts.isTryStatement(tryStatement) || tryStatement.finallyBlock !== undefined || tryStatement.tryBlock.statements.length !== 1) return undefined;
  const returnStatement = tryStatement.tryBlock.statements[0];
  if (!ts.isReturnStatement(returnStatement) || !isPinnedCommonJsInitializerCatch(tryStatement.catchClause)) return undefined;
  return isPinnedCommonJsInitializerReturn(returnStatement.expression);
};

const collectPinnedCommonJsInitializerDeclarations = (node: ts.Node, policy: StaticClosurePolicy): PinnedCommonJsInitializers => {
  const getOwnPropNamesDeclarations = new Set<ts.Identifier>();
  const getOwnPropNames = new Set<ts.Identifier>();
  const candidates = new Map<string, ts.Identifier[]>();
  const visitForGetOwn = (child: ts.Node): void => {
    const declared = isGetOwnPropNamesDeclaration(child);
    if (declared !== undefined) getOwnPropNamesDeclarations.add(declared);
    ts.forEachChild(child, visitForGetOwn);
  };
  const visitForDefinitions = (child: ts.Node): void => {
    if (ts.isVariableDeclaration(child)) {
      const reference = isCommonJsInitializerDefinition(child, policy);
      if (reference !== undefined) {
        const name = (child.name as ts.Identifier).text;
        candidates.set(name, [...(candidates.get(name) ?? []), child.name as ts.Identifier]);
        getOwnPropNames.add(reference);
      }
    }
    const copyPropsReference = pinnedCopyPropsReference(child);
    if (copyPropsReference !== undefined) getOwnPropNames.add(copyPropsReference);
    const esmReference = pinnedEsmReference(child);
    if (esmReference !== undefined) getOwnPropNames.add(esmReference);
    ts.forEachChild(child, visitForDefinitions);
  };
  visitForGetOwn(node);
  visitForDefinitions(node);
  const declarations = new Set([...candidates.values()].flatMap((candidates) => candidates.length === 1 ? candidates : []));
  return {
    declarations,
    getOwnPropNames: getOwnPropNamesDeclarations.size === 1 && getOwnPropNames.size > 0 ? new Set([...getOwnPropNamesDeclarations, ...getOwnPropNames]) : new Set(),
    requireDefinitions: new Set(),
  };
};

export const isCommonJsCandidateIdentifier = (identifier: string, policy: StaticClosurePolicy): boolean => {
  if (has(policy.emitted.commonJsInitializerIdentifiers, identifier)) return true;
  if (policy.emitted.commonJsInitializerIdentifiers.some((identifierLike) => identifier.includes(identifierLike))) return true;
  return new RegExp(policy.emitted.commonJsReservedIdentifierPattern, "iu").test(identifier);
};

export const collectPinnedCommonJsInitializerIdentifiers = (
  node: ts.Node,
  policy: StaticClosurePolicy
): PinnedCommonJsInitializers => {
  const pinned = collectPinnedCommonJsInitializerDeclarations(node, policy);
  const requireDefinitions = new Set<ts.Identifier>();
  const declarationNames = new Set([...pinned.declarations].map((identifier) => identifier.text));
  const visit = (child: ts.Node): void => {
    if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.initializer !== undefined && declarationNames.has(child.name.text)) {
      if (ts.isArrowFunction(child.initializer) && ts.isFunctionExpression(child.initializer.body)) {
        const requireDefinition = child.initializer.body.name;
        if (requireDefinition !== undefined && ts.isIdentifier(requireDefinition) && requireDefinition.text === "__require") {
          requireDefinitions.add(requireDefinition);
        }
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return { ...pinned, requireDefinitions };
};

export const isExactCommonJsInitializerCall = (
  node: ts.CallExpression,
  policy: StaticClosurePolicy,
  declarations: ReadonlySet<ts.Identifier>
): boolean => {
  if (node.typeArguments !== undefined) return false;
  if (node.questionDotToken !== undefined) return false;
  if (!ts.isIdentifier(node.expression)) return false;
  const initializerName = node.expression.text;
  if (!has(policy.emitted.commonJsInitializerIdentifiers, initializerName)) return false;
  if (![...declarations].some((declaration) => declaration.text === initializerName)) return false;
  if (node.arguments.length !== 1) return false;
  return isCommonJsInitializerArgument(node.arguments[0]);
};
