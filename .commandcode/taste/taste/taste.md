# Taste
- Optimizes 3D-printed parts for low material/print cost (less filament, faster prints) while explicitly requiring structural strength to be preserved. Confidence: 0.65
- Prefers weight/size reductions to be done systematically (analysis-driven, tunable parameters) rather than ad hoc. Confidence: 0.5
- Prefers honeycomb/hexagonal patterns for lightening cutouts and openings instead of plain rectangular holes — judges parts by looks as well as function. Confidence: 0.6
- Requires design changes to be verified as structurally sound, not just visually pleasing (e.g. "make sure it's structurally perfect and looks good"). Confidence: 0.55
- Expects 3D/CAD edits to respect the model's true physical scale and real dimensions (works in real mm, not arbitrary/relative units) and to be grounded in measured geometry. Confidence: 0.5
- Wants new agent capabilities researched on the web and installed as native, globally-registered Command Code skills (e.g. `cmdc skills add --global`, `~/.commandcode/skills`) rather than ad-hoc one-off scripts. Confidence: 0.6
- Prefers tooling that operates directly on existing assets in their current format (e.g. directly editing existing .stl files) over workflows that require conversion or regeneration. Confidence: 0.5
- Expects the agent to reuse previously set-up skills/tooling instead of writing bespoke custom code; questions why custom code is being written when an established skill exists. Confidence: 0.6
