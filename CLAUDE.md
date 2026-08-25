# Talli

Static site (plain HTML/CSS/JS) backed by Supabase. Booking flow lives in
`assets/booking.js`, admin views in `assets/admin.js`, shared config in
`assets/talli-config.js`.

## Supabase environments

| Environment | Project name | Project ID | Notes |
| --- | --- | --- | --- |
| Test | `talli-test` | `uhdoverwvlxvyyctskle` | Scratch. Safe to break. |
| Production | andrewcnicholls-source's Project | `oxzwfemyavznykqixhvk` | Live site data. |

`assets/talli-config.js` points at the production project.

## Database permission policy

Andrew's standing instruction, enforced by the `PreToolUse` hook at
`.claude/hooks/supabase-permissions.py`:

1. **Test environment is fully automated.** Any Supabase operation against
   `uhdoverwvlxvyyctskle` runs without asking — including drops and deletes.
   It does not matter if the test database breaks.
2. **Promoting test to production is automated.** Once Andrew says test is
   ready to go to prod, apply the changes directly. `execute_sql` and
   `apply_migration` against `oxzwfemyavznykqixhvk` run without asking.
   Don't ask him to confirm a migration he has already approved.
3. **Destructive production SQL still asks.** `DROP` of any object,
   `DROP COLUMN`, `TRUNCATE`, and `DELETE`/`UPDATE` with no `WHERE` clause
   against production stop for confirmation.
4. **Everything else asks.** Edge function deploys, project lifecycle
   (create/pause/restore), and branch operations against production are not
   pre-approved. Nor is any project ID the hook doesn't recognise.

Read-only introspection (`list_*`, `get_*`, `query_logs`,
`generate_typescript_types`, `search_docs`) runs unprompted on either project.

### Working practice

Develop and iterate against **test**. Only touch production when Andrew has
said the change is ready to promote. When promoting, prefer `apply_migration`
over raw `execute_sql` for DDL so the change is recorded in the migration
history.

### Changing the policy

Edit `.claude/hooks/supabase-permissions.py` — the project IDs and the
destructive-statement patterns are constants near the top. The hook only ever
returns `allow` or `ask`, never `deny`, so anything it stops can still be
approved at the prompt.
