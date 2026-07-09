---
title: Skins
description: How Simfile worlds become maps without changing the schema.
---

Skins are presentation packs for the viewer. They can render the same run as a dense ASCII console, office floorplan, city, factory, abstract organization map, or later a non-flat world surface.

Skins never add simulation semantics. They map recorded scopes and entities to visual anchors.

## First Skin

The default replay console is viewer-owned and tile-first:

- rooms become wall and floor glyph regions,
- corridors become routed tile paths,
- agents become glyph occupants,
- variables, markers, and probes become colored overlays,
- panels and legends stay outside the Simfile schema.

The tile world is built from run artifacts first, then painted into the flat console. That keeps the data model portable if the viewer later projects the same world onto another surface.

## Possible Viewer Tooling

This is not part of the v0.1 CLI. A later viewer-owned workflow could look like:

```bash
simfile skin init office-floor
simfile skin validate skins/office-floor
simfile skin preview skins/office-floor --run runs/latest
simfile skin pack skins/office-floor
```

Those commands would validate presentation assets and references only. They would not add Simfile keys or change the simulation schema.

## Asset Sources

Visual assets should be explicit, licensed, and replaceable. ASCII/glyph maps, floorplan drawings, low-poly packs, and generated bitmap assets can all be valid skins as long as the source and license are tracked.
