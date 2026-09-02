#!/usr/bin/env python3
"""PreToolUse gate for Supabase MCP tools.

Permission policy (see CLAUDE.md):
  * test project      -> everything runs unprompted
  * production        -> reads and non-destructive migrations run unprompted;
                         data-destroying SQL asks first
  * anything else     -> asks

On production, "data-destroying" includes a DELETE from any table holding
bookings, payments or registered interest, WHERE clause or not. Taking a
fixture off sale is a status change and stays unprompted; removing the row
is not the same act and does not.

Emits a PreToolUse permissionDecision of "allow" (run silently) or "ask"
(fall through to the normal prompt). It never emits "deny" -- the user can
always approve at the prompt.
"""
import json
import re
import sys

TEST_PROJECT = "uhdoverwvlxvyyctskle"        # talli-test
PROD_PROJECT = "oxzwfemyavznykqixhvk"        # live site

# Read-only / introspection tools: safe against either project.
READ_ONLY = {
    "list_tables", "list_extensions", "list_migrations", "list_projects",
    "list_organizations", "list_edge_functions", "list_branches",
    "get_project", "get_project_url", "get_publishable_keys", "get_advisors",
    "get_edge_function", "get_organization", "get_cost",
    "generate_typescript_types", "query_logs", "search_docs",
}

# Tools that write SQL; gated by the destructive-statement check on prod.
SQL_WRITE = {"execute_sql", "apply_migration"}

# Tables whose rows are money taken, or a person who asked to be told
# something. Deleting one of these on production is not recoverable from
# anything this project keeps, so it asks even with a WHERE clause -- a
# precise DELETE of the wrong row is still gone.
#
# The database refuses the worst of it on its own: an event with bookings
# or registered interest cannot be deleted at all, only taken off sale
# (20260902090000_talli_event_deletion_guard). This is the second lock,
# on the other side of the door: it stops the attempt being made silently
# rather than relying on the guard to catch it.
PROTECTED_TABLES = (
    "event", "event_interest", "booking", "booking_addon",
    "bay_allocation", "booking_cancellation", "booking_transfer",
)

DESTRUCTIVE = [
    (re.compile(r"\bDROP\s+(TABLE|SCHEMA|DATABASE|VIEW|MATERIALIZED\s+VIEW|"
                r"FUNCTION|TRIGGER|POLICY|INDEX|TYPE|EXTENSION|ROLE|"
                r"PUBLICATION|SEQUENCE)\b", re.I), "DROP of a database object"),
    (re.compile(r"\bDROP\s+COLUMN\b", re.I), "DROP COLUMN"),
    # Removing a constraint or switching a trigger off removes an invariant
    # while leaving every row in place, so nothing looks wrong afterwards.
    (re.compile(r"\bDROP\s+CONSTRAINT\b", re.I), "DROP CONSTRAINT"),
    (re.compile(r"\bDISABLE\s+TRIGGER\b", re.I), "DISABLE TRIGGER"),
    (re.compile(r"\bTRUNCATE\b", re.I), "TRUNCATE"),
    (re.compile(r"\bDELETE\s+FROM\s+(?:public\s*\.\s*)?\"?(?:"
                + "|".join(PROTECTED_TABLES) + r")\"?(?![\w$])", re.I),
     "DELETE from a table holding bookings, payments or registered interest"),
]


def strip_noise(sql: str) -> str:
    """Remove comments and string literals so keyword matching is honest."""
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    sql = re.sub(r"--[^\n]*", " ", sql)
    sql = re.sub(r"\$\$.*?\$\$", " ", sql, flags=re.S)
    sql = re.sub(r"'(?:[^']|'')*'", "''", sql)
    return sql


def unfiltered_write(statement: str) -> str | None:
    """DELETE/UPDATE with no WHERE clause hits every row."""
    for verb, pattern in (("DELETE", r"^\s*DELETE\s+FROM\b"),
                          ("UPDATE", r"^\s*UPDATE\b")):
        if re.search(pattern, statement, re.I) and not re.search(
                r"\bWHERE\b", statement, re.I):
            return f"{verb} with no WHERE clause"
    return None


def destructive_reason(sql: str) -> str | None:
    cleaned = strip_noise(sql)
    for pattern, label in DESTRUCTIVE:
        if pattern.search(cleaned):
            return label
    for statement in cleaned.split(";"):
        reason = unfiltered_write(statement)
        if reason:
            return reason
    return None


def decide(tool: str, args: dict) -> tuple[str, str]:
    project = args.get("project_id", "")

    if project == TEST_PROJECT:
        return "allow", "talli-test: test environment is unrestricted"

    if tool in READ_ONLY:
        return "allow", f"{tool} is read-only"

    if project != PROD_PROJECT:
        return "ask", f"unrecognised project_id {project!r}"

    if tool in SQL_WRITE:
        reason = destructive_reason(args.get("query", ""))
        if reason:
            return "ask", f"production {tool}: {reason}"
        return "allow", f"production {tool}: no destructive statements"

    return "ask", f"{tool} on production is not pre-approved"


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return  # malformed input: stay silent, normal prompting applies

    tool_name = payload.get("tool_name", "")
    if not tool_name.startswith("mcp__Supabase__"):
        return

    decision, reason = decide(
        tool_name[len("mcp__Supabase__"):],
        payload.get("tool_input") or {},
    )
    json.dump({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": decision,
        "permissionDecisionReason": reason,
    }}, sys.stdout)


if __name__ == "__main__":
    main()
