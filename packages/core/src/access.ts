import type { Action, ActionAccessPolicy } from "./types";
import { actionMeta, type ActionAccessInfo } from "./action-meta";

export type { ActionAccessPolicy, ActionAccessInfo };

/**
 * Record how an action is protected, for tools that cannot read it from the
 * configuration: plugins such as `crud` enforce access inside `execute`, so the
 * action has no `authorize` to find. Introspection, OpenAPI, and the dashboard
 * read what is recorded here.
 *
 * @param action - The action to describe.
 * @param info - Whether it checks authorization and whether it scopes queries,
 * and the resulting policy.
 */
export function setActionAccess(action: object, info: ActionAccessInfo): void {
  actionMeta(action).access = {
    hasAuthorize: info.hasAuthorize,
    hasScope: info.hasScope,
    policy: info.policy,
  };
}

/**
 * How an action is protected: `"public"` when nothing checks the caller,
 * `"authorized"` when an `authorize` does, and `"scoped"` when the action also
 * limits what rows the caller can reach. It reads what a plugin recorded with
 * `setActionAccess`, else the action's own `authorize`, and keeps the policy
 * consistent with the flags.
 *
 * @param action - An action, or any object a plugin described.
 * @returns `hasAuthorize`, `hasScope`, and `policy`.
 */
export function getActionAccess(action: Action | object): ActionAccessInfo {
  const meta = actionMeta(action).access;
  const configAuthorize =
    typeof (action as Partial<Action>).config?.authorize === "function";
  if (!meta) {
    return {
      hasAuthorize: configAuthorize,
      hasScope: false,
      policy: configAuthorize ? "authorized" : "public",
    };
  }
  const hasAuthorize = configAuthorize || Boolean(meta.hasAuthorize);
  const hasScope = Boolean(meta.hasScope);
  let policy: ActionAccessPolicy =
    meta.policy ??
    (hasAuthorize ? (hasScope ? "scoped" : "authorized") : "public");
  // Normalize conflicting metadata so the policy always agrees with the
  // effective flags (e.g. metadata stamped "public" on an action that also
  // declares config.authorize must not report policy "public").
  if (policy === "public" && hasAuthorize)
    policy = hasScope ? "scoped" : "authorized";
  else if (policy !== "public" && !hasAuthorize) policy = "public";
  else if (policy === "scoped" && !hasScope) policy = "authorized";
  return { hasAuthorize, hasScope, policy };
}
