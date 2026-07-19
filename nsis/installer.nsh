; Benutzerdefinierte NSIS-Erweiterung für GoBDesk (eingebunden über
; `nsis.include` in electron-builder.yml). Wirkt in Installer UND Uninstaller,
; da der Include vor installer.nsi in beide Kompilate übernommen wird.

; ---------------------------------------------------------------------------
; customRemoveFiles – Ursache des „GoBDesk kann nicht geschlossen werden"
; ---------------------------------------------------------------------------
; Beim UPDATE löscht der Standard-Uninstaller nicht direkt, sondern verschiebt
; jede Datei zuerst per Rename nach %TEMP%\nsXXXX.tmp\old-install (Rollback-
; Sicherheit, un.atomicRMDir). Die mitgelieferten factur-x-XSD-Dateien haben
; extrem lange Namen. Unter der langen %TEMP%-Basis überschreiten mehrere davon
; die 260-Zeichen-Grenze (MAX_PATH), MoveFile schlägt fehl → der Uninstaller
; bricht ab (Abort) → uninstallOldVersion meldet nach 5 Versuchen fälschlich
; „GoBDesk kann nicht geschlossen werden". Tritt nur beim Update auf und nur,
; weil die Dateien am Zielort (Temp) länger werden als am kurzen Installationsort.
;
; Lösung: direkt in-place löschen (Pfade < 260, kein Umzug nach %TEMP%) –
; laufwerks- und pfadlängenunabhängig. Entspricht dem Verhalten des Standard-
; Uninstallers im Nicht-Update-Fall.
!macro customRemoveFiles
  SetOutPath $TEMP
  RMDir /r $INSTDIR
!macroend
