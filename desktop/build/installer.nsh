# MorphoGem Custom NSIS Lifecycle Hooks
# Preserves user subfolders ($INSTDIR\Projects, Exports, Mods, userdata) across all updates and uninstalls.

!macro customInstall
  CreateDirectory "$INSTDIR\Projects"
  CreateDirectory "$INSTDIR\Exports"
  CreateDirectory "$INSTDIR\Mods"
  CreateDirectory "$INSTDIR\userdata"
!macroend

!macro customRemoveFiles
  SetOutPath $TEMP
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\swiftshader"
  Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\LICENSE*"
  Delete "$INSTDIR\uninstallerIcon.ico"
  # Non-recursive RMDir: cleans up $INSTDIR only if empty; keeps Projects/Exports/Mods/userdata intact!
  RMDir "$INSTDIR"
!macroend
