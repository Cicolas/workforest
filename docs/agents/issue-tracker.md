# Issue tracker: GitHub

Tickets and specs live in GitHub Issues for `Cicolas/workforest`.
Use the `gh` CLI from this repository.

## Operations

- Create: `gh issue create --title "..." --body-file <file>`
- Read: `gh issue view <number> --json title,body,labels,comments`
- List: `gh issue list --state open --json number,title,labels`
- Comment: `gh issue comment <number> --body-file <file>`
- Label: `gh issue edit <number> --add-label "<label>"`
- Remove label: `gh issue edit <number> --remove-label "<label>"`
- Close: `gh issue close <number>`

Write multiline bodies to a temporary file and pass `--body-file`.

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the issue and its comments.

## Specs and implementation tickets

Keep each spec in an issue. Link implementation tickets to their spec
and explicitly record their blockers.

Use native GitHub issue dependencies when available. Otherwise, put
`Blocked by: #<number>, #<number>` near the top of the ticket body.
A ticket is ready for implementation when all blockers are closed.

## Wayfinding

Keep the map in one issue labelled `wayfinder:map`.
Link decision tickets as sub-issues, or use a task list in the map
and a `Part of #<map>` reference in each ticket.

Use `wayfinder:<type>` labels for research, prototype, grilling, and task.
Choose open, unassigned tickets whose blockers are closed, in map order.
Claim with `gh issue edit <number> --add-assignee @me`.
Resolve by recording the answer, closing the ticket, and adding a
summary and link to the map's decisions.

## Pull requests as a triage surface

PRs as a request surface: no.
