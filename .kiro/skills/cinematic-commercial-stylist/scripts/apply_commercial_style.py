#!/usr/bin/env python3
"""
Commercial Aesthetic Style Generator & Injector for LTX-2.3
Injects reverse-engineered commercial visual profiles (ChatGPT Domestic Slat, Transit Intimacy,
Heinz Bleachers, Athletic Sanctuary, Urban Pastoral) into any LTX-2.3 JSON scene prompt.
"""

import sys
import os
import json
import argparse

STYLE_PROFILES = {
    "domestic_golden_slat": {
        "lens": "35mm Cooke S4 prime cinema lens",
        "starting_height": "1.3m eye level",
        "movement": "Steady observational hold with subtle organic human breathing and 0.2m slow lateral glide",
        "lighting_source": "Direct morning sunlight streaming through wooden venetian blinds at a 45-degree angle",
        "lighting_temperature": "3200K-3500K warm morning sunlight mixed with soft 5600K ambient daylight",
        "lighting_quality": "Crisp directional sunlight projecting sharp horizontal linear slat shadows, balanced by soft warm bounce from terracotta tiles",
        "film_stock": "Kodak Portra 400 warm 35mm celluloid film response",
        "grade": "Kodak 2383 Print LUT with warm sepia lifted shadows, creamy skin tones, and rich earthy terracotta",
        "palette": ["#B86B43", "#E3A857", "#2D4739", "#E85A1E", "#FAF4EC"],
        "grain": "Fine 35mm organic celluloid grain structure with subtle gate texture",
        "halation": "Delicate golden-red halation blooming softly around bright window trim and metallic specular glints",
        "textures": "Glazed ceramic tile grout, stainless steel brush lines, coarse cotton bandana weave, rising steam ribbons, natural skin pores"
    },
    "moody_transit_intimacy": {
        "lens": "28mm wide cinema prime lens",
        "starting_height": "1.2m seated eye level",
        "movement": "Subtle handheld breathing within vehicle interior, keeping subjects centered between seat headrests",
        "lighting_source": "Exterior daylight entering side vehicle windows",
        "lighting_temperature": "5000K afternoon daylight mixed with cool blue vehicle interior",
        "lighting_quality": "Warm side key grazing hair and cheekbones, moody fall-off into deep shadow floor",
        "film_stock": "Kodak Vision3 500T (5219) 35mm motion picture film stock",
        "grade": "Subtle cyan shadow undertone, warm amber skin highlights, fine 35mm grain",
        "palette": ["#1C2541", "#3A506B", "#4DB8B8", "#D4A373", "#F4F1DE"],
        "grain": "Organic 35mm motion picture grain with natural shadow latitude",
        "halation": "Mild halation around window edges and phone screen specular reflections",
        "textures": "Coarse patterned transit moquette velour, braided scalp lines, matte plastic phone case, polished steel handrail"
    },
    "athletic_sanctuary": {
        "lens": "28mm-32mm wide prime lens",
        "starting_height": "1.5m elevated looking down to seated 0.5m bench",
        "movement": "Locked-off wide environmental portrait with deep focus",
        "lighting_source": "Soft daylight through white linen window drapes on frame left",
        "lighting_temperature": "5000K natural window light with 3200K warm interior bounce",
        "lighting_quality": "Soft directional key, clean chrome specular glints, soft carpet shadows",
        "film_stock": "Kodak Tri-X / Portra 400 hybrid aesthetic",
        "grade": "Desaturated earthy interior with a single hyper-saturated chromatic anchor",
        "palette": ["#7A3E20", "#C89F65", "#E85A1E", "#343A40", "#F8F9FA"],
        "grain": "Tactile, punchy 35mm film grain with deep shadow density",
        "halation": "Subtle chrome highlight bloom",
        "textures": "Knurled chrome dumbbell handle, plush wool carpet pile, cracked vintage leather, sheer linen drape"
    },
    "subdued_crowd_focal_pop": {
        "lens": "85mm-105mm medium telephoto lens",
        "starting_height": "1.5m tier level",
        "movement": "Rock-steady locked-off tripod observational hold with zero camera drift",
        "lighting_source": "High-altitude diffuse overcast summer daylight",
        "lighting_temperature": "5400K natural overcast daylight balanced",
        "lighting_quality": "Soft, shadowless open-sky wrap-around light with gentle 1.8:1 contrast and lifted shadows under cap visors",
        "film_stock": "Kodak Vision3 250D (5207) Daylight stock",
        "grade": "Kodak 2383 Print LUT with muted summer neutrals (ecru, sand beige, washed denim) and isolated hyper-saturated primary red",
        "palette": ["#D91414", "#00A4D3", "#D8C7B5", "#F2EDE4", "#48535A"],
        "grain": "Fine 35mm motion picture grain with authentic organic gate weave",
        "halation": "Subtle golden rim halation around white sun visors and spectator shirt collars",
        "textures": "Ribbed knit cable wool, cotton polo fabric weave, crinkled nylon windbreaker, smooth plastic squeeze bottle, crusty bread crust"
    },
    "urban_pastoral_whimsy": {
        "lens": "35mm cinema prime lens",
        "starting_height": "1.4m eye level",
        "movement": "Symmetrical locked-off environmental portrait with subtle organic air density",
        "lighting_source": "Diffuse overcast British daylight",
        "lighting_temperature": "5600K overcast daylight balanced",
        "lighting_quality": "Soft wrap-around ambient light with gentle directional falloff",
        "film_stock": "Kodak Vision3 250D Daylight",
        "grade": "Natural earthy warmth punctuated by vivid brand Kelly green",
        "palette": ["#06C167", "#C9A04E", "#A04A32", "#EAE6DF", "#4A5568"],
        "grain": "Crisp 35mm daylight film grain",
        "halation": "Gentle sky edge halation",
        "textures": "Coarse canvas beekeeper suit, weathered splintered timber, terracotta pottery, fresh burger bun, brass bee smoker"
    }
}

def inject_style(target_json_path, style_name, output_path=None):
    if not os.path.exists(target_json_path):
        print(f"[-] File not found: {target_json_path}")
        sys.exit(1)

    if style_name not in STYLE_PROFILES:
        print(f"[-] Unknown style: '{style_name}'. Available: {list(STYLE_PROFILES.keys())}")
        sys.exit(1)

    with open(target_json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    style = STYLE_PROFILES[style_name]

    # Inject optics
    if "camera" not in data:
        data["camera"] = {}
    data["camera"]["lens"] = style["lens"]
    data["camera"]["starting_height"] = style["starting_height"]

    # Inject lighting
    if "lighting" not in data:
        data["lighting"] = {}
    data["lighting"]["source"] = style["lighting_source"]
    data["lighting"]["temperature"] = style["lighting_temperature"]
    data["lighting"]["quality"] = style["lighting_quality"]

    # Inject color & finish
    if "color_and_finish" not in data:
        data["color_and_finish"] = {}
    data["color_and_finish"]["film_character"] = style["film_stock"]
    data["color_and_finish"]["grade"] = style["grade"]
    data["color_and_finish"]["palette"] = style["palette"]
    data["color_and_finish"]["grain"] = style["grain"]
    data["color_and_finish"]["halation"] = style["halation"]
    data["color_and_finish"]["texture"] = style["textures"]

    out = output_path if output_path else target_json_path
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)

    print(f"[+] Style '{style_name}' successfully applied to {out}")

def main():
    parser = argparse.ArgumentParser(description="Apply signature commercial aesthetic profiles to LTX-2.3 scene JSON prompts.")
    parser.add_argument("json_file", help="Path to target LTX-2.3 scene JSON file")
    parser.add_argument("--style", required=True, choices=list(STYLE_PROFILES.keys()), help="Name of style profile to apply")
    parser.add_argument("--output", help="Optional output path")
    args = parser.parse_args()

    inject_style(args.json_file, args.style, args.output)

if __name__ == "__main__":
    main()
