# Project Naming Brainstorm

## Status: In Progress

Exploring memorable names with strong metaphorical connections to the project's
core qualities: durability, symbiosis (XState + PG), resilience under chaos,
and structured progression through states.

## Design Criteria

- Memorable and distinctive in the dev tools space
- Short enough for `import from '...'` and CLI usage
- Metaphor rewards curiosity (biological/natural references)
- Mascot/logo potential
- npm and domain availability preferred

## Themes Explored

### 1. Lichen (symbiosis + extreme durability)

Lichen = algae + fungi in symbiosis, survives extreme environments. Maps to
XState + PG working together, tolerating crashes/restarts.

| Name | Notes |
|---|---|
| **Rockbloom** | Poetic, lichen growing on bare stone. Implies emergence from nothing. |
| **Holdfast** | How lichen anchors to substrate. Strong, active, implies grip. Also nautical/climbing term. |
| Xanthoria | Real lichen genus starting with X (XState echo). Bold, scientific. |
| Cladonia | Real genus, sounds technical/modern. |
| Thallo | From "thallus" (lichen body). Friendly, app-like. |
| Soredia | Lichen propagation bundles. Elegant, maps to spawning instances. |
| Cortex | Protective outer layer. Also brain/core connotation. |

### 2. Tardigrade (extremophile, indestructible)

Microscopic animals that survive vacuum, radiation, boiling, freezing, desiccation.
Already have cult following. No symbiosis connection but maximum durability metaphor.

| Name | Notes |
|---|---|
| **Waterbear** | Common name for tardigrade. Maximum memorability, instant mascot potential. |
| Tun | The desiccated survival state. Perfect metaphor but collides with tap/tun networking. |
| Slowstep | "Tardigrade" literally means "slow stepper" in Latin. State machines step through states. |
| Cryptobiont | Organisms that survive suspended animation. Too long for a package name. |

### 3. Crab / Intertidal (methodical movement through chaos)

Image: a crab walking sideways across rocks as waves crash over it, never missing
a step. Crabs have exoskeletons (structure), molt (state transitions), thrive at
the boundary of order and chaos.

| Name | Notes |
|---|---|
| **Carapace** | The hard protective shell. Elegant word, strong metaphor for workflow logic wrapped in durable infrastructure. |
| **Breakwater** | Structure that absorbs wave impact, keeps things stable behind it. Infrastructure energy. |
| Scuttle | How crabs move, "move quickly." Fun but also means "willfully destroy a ship" — dealbreaker. |
| Tidewalk | Walking through crashing tides, never stopping. |
| Chitin | Shell material, lightweight + strong. Sounds good but reference is too oblique. |
| Littoral | The intertidal zone. Where order meets chaos. |
| Ironshore | Jagged coastal rock formations. Indestructible foundation. |

## Shortlist

| Name | Theme | npm | Vibe | Tagline seed |
|---|---|---|---|---|
| **Rockbloom** | Lichen | **Free** | Poetic, emergence | "Durable state that grows on anything" |
| **Breakwater** | Coastal | **Free** | Infrastructure, protection | "Absorb the chaos, keep state safe" |
| **Holdfast** | Lichen | Squatted (abandoned) | Strong, reliable | "State machines that never let go" |
| **Waterbear** | Tardigrade | Squatted (abandoned) | Fun, mascot-ready | "Indestructible workflows" |
| **Carapace** | Crab | Squatted (abandoned) | Elegant, structural | "A hard shell for your workflow logic" |

### npm Availability (checked 2026-03-09)

- **rockbloom** — not registered, fully available
- **breakwater** — not registered, fully available
- **holdfast** — 0.0.4, abandoned Docker tool (ancient deps, last publish years ago)
- **waterbear** — 1.0.4, tiny template engine (no deps, low usage)
- **carapace** — 1.0.2, image manipulation lib (ancient deps, last publish years ago)

Scoped packages (`@name/*`) are always available regardless of base name squatting.

## Open Questions

- Domain availability (.dev, .io, .com) not yet checked
- Whether to pursue npm dispute for squatted names or use scoped packages
- Final selection pending — sitting with the shortlist
