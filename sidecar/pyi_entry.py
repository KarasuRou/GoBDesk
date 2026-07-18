"""PyInstaller-Einstiegspunkt für das gebündelte Sidecar-Binary.

Das Binary verhält sich wie `py -3.11 -m einvoice`: JSON-Request über stdin,
Ergebnis-JSON über stdout. So braucht der Endanwender kein installiertes Python.
"""

from einvoice.__main__ import main

if __name__ == "__main__":
    main()
