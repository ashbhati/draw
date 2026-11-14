# Supplied visual reference

`specification-implementation-validation.png` is the chalkboard diagram supplied by the Draw product owner on 2026-11-04. It is retained as a visual reference for the V1 theme and the Specification → Implementation → Validation flow.

`draw-human-agent-mcp-overview.png` is the owner-supplied product diagram added to the V1.2.0 documentation on 2026-11-13. It shows direct human editing through Draw UI and agent editing through Draw MCP converging on the same editable diagram.

`tests/fixtures/specification-implementation-validation.draw` is a native editable reconstruction of that flow. It focuses on the three-node top row, including the feedback edge, so automated checks can verify layout, contrast, routing, and editability. The lower human/machine illustrations in the reference are visual guidance and are not recreated in this fixture.
