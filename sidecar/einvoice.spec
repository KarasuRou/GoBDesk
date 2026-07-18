# PyInstaller-Spec für den GoBDesk-Sidecar (onedir-Bundle).
#
# Baut ein eigenständiges `einvoice`-Binary ohne Python-Installation.
# Aufruf (aus dem Projekt-Root, CWD-unabhängig via SPECPATH):
#   npm run bundle:sidecar
#   bzw. py -3.11 -m PyInstaller sidecar/einvoice.spec --noconfirm --clean \
#        --distpath sidecar/dist --workpath sidecar/build
# Ergebnis: sidecar/dist/einvoice/einvoice.exe (+ _internal/). Wird per
# electron-builder nach resources/sidecar/ ausgeliefert (electron-builder.yml).

import os

from PyInstaller.utils.hooks import collect_all

# Schriften echt mit einbetten (siehe pdf_builder.py -> sys._MEIPASS/fonts).
datas = [
    (os.path.join(SPECPATH, "fonts", "DejaVuSans.ttf"), "fonts"),
    (os.path.join(SPECPATH, "fonts", "DejaVuSans-Bold.ttf"), "fonts"),
]
binaries = []
hiddenimports = ["einvoice.extract", "einvoice.validate", "einvoice.inbound"]  # lazy imports in __main__ -> explizit sichern

# Datendateien (XSD/Schematron von factur-x, reportlab-Ressourcen) mitnehmen.
for pkg in ("facturx", "reportlab", "lxml", "pypdf"):
    pkg_datas, pkg_binaries, pkg_hidden = collect_all(pkg)
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hidden

a = Analysis(
    [os.path.join(SPECPATH, "pyi_entry.py")],
    pathex=[SPECPATH],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="einvoice",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="einvoice",
)
