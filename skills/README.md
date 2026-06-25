# Skills moved to HQ

The `create-growth-dashboard` skill that used to live here is now maintained in
HQ as a company-scoped skill (the canonical source of truth):

    companies/fourteen10/skills/create-growth-dashboard/

It surfaces in Claude Code as `fourteen10:create-growth-dashboard`, auto-loads on
HQ startup, and syncs to the team. The skill still scaffolds dashboards from this
framework by pinning to its published release tags over jsDelivr, so it never
needed to be co-located with the framework code.

To change the dashboard build process, edit the HQ copy. To change shared
dashboard behaviour, edit this framework and cut a new release tag.
