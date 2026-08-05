# Attachment Audit hero capture brief

Goal: show that the plugin finds reclaimable junk with evidence before the user deletes anything.

## Primary story
A buyer should understand three things in about two seconds:
1. this is an audit dashboard, not a random file manager
2. it finds real reclaimable waste
3. cleanup looks safer and more evidence-based than a generic orphan finder

## Best hero capture
Capture the dashboard in a live Obsidian vault with:
- reclaimable space total visible
- at least 3 detector groups visible, ideally Unused, Duplicates, and Large files
- 1-2 filename rows visible under each so it feels real
- duplicate cluster or preview visible if it fits without making text tiny

## Best supporting proof shot
Secondary still or GIF should show:
- one suspicious file selected
- evidence or reason visible
- safe action options visible (trash, move, ignore, mark reviewed, restore/history if relevant)

## Avoid
- empty dashboard states
- too much side chrome or dead space
- tiny unreadable filenames
- a hero that only shows settings instead of audit results
- any fake file list that does not come from a real vault/demo state

## File targets
- hero still: `docs/assets/hero.png`
- secondary proof still or GIF: `docs/assets/proof-audit-flow.gif`

## Caption guidance
Use explicit honesty-first captions if compositing is needed:
- live Obsidian dashboard capture from a real demo vault
- plugin-generated scan results from the same demo state
