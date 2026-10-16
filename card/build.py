#!/usr/bin/env python3
"""Inline the subset brand fonts into index.html."""
import base64, pathlib

d = pathlib.Path(__file__).parent
html = (d / "index.template.html").read_text()
for token, font in (("__JOST_B64__", "jost.woff2"), ("__MONO_B64__", "mono.woff2")):
    html = html.replace(token, base64.b64encode((d / "fonts" / font).read_bytes()).decode())
(d / "index.html").write_text(html)
print(f"built index.html, {len(html.encode()) // 1024} KB")
