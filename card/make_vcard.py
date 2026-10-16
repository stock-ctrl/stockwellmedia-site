#!/usr/bin/env python3
"""Write contact.vcf, folded to the 75 octet limit per RFC 2426."""
import pathlib

FIELDS = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "N:Curtis;Stock;;;",
    "FN:Stock Curtis",
    "ORG:Stockwell Media Co",
    "TITLE:Founder",
    "TEL;TYPE=CELL,VOICE:+18167972739",
    "EMAIL;TYPE=INTERNET,PREF:stock@stockwellmedia.com",
    "URL:https://stockwellmedia.com",
    "ADR;TYPE=WORK:;;;Springfield;MO;;USA",
    "NOTE:Dashboards, daily briefs, and custom tools for owners and contractors "
    "who want more jobs and less paperwork.",
    "END:VCARD",
]

def fold(line, limit=75):
    """Continuation lines start with a single space and are stripped on parse."""
    out, buf = [], line.encode()
    while len(buf) > limit:
        cut = limit
        while cut > 0 and (buf[cut] & 0xC0) == 0x80:  # never split a utf-8 sequence
            cut -= 1
        out.append(buf[:cut].decode())
        buf = b" " + buf[cut:]
        limit = 75
    out.append(buf.decode())
    return out

lines = [f for line in FIELDS for f in fold(line)]
pathlib.Path(__file__).parent.joinpath("contact.vcf").write_bytes(
    ("\r\n".join(lines) + "\r\n").encode()
)
print(f"wrote contact.vcf, {len(lines)} lines, longest {max(len(l.encode()) for l in lines)} octets")
