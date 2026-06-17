; Registro de Rave como navegador predeterminado en Windows
; Se ejecuta tras la instalación de los archivos.

!macro customInstall
  ; ProgID principal
  WriteRegStr HKCU "Software\Classes\RaveBrowser" "" "Rave Browser Document"
  WriteRegStr HKCU "Software\Classes\RaveBrowser" "FriendlyTypeName" "Rave Browser Document"
  WriteRegStr HKCU "Software\Classes\RaveBrowser\Application" "ApplicationName" "Rave"
  WriteRegStr HKCU "Software\Classes\RaveBrowser\Application" "AppUserModelId" "com.rave.browser"
  WriteRegStr HKCU "Software\Classes\RaveBrowser\DefaultIcon" "" "$INSTDIR\Rave.exe,0"
  WriteRegStr HKCU "Software\Classes\RaveBrowser\shell\open\command" "" '"$INSTDIR\Rave.exe" "%1"'

  ; Capabilities (necesario para aparecer en Aplicaciones predeterminadas de Windows)
  WriteRegStr HKCU "Software\Rave\Capabilities" "ApplicationName" "Rave"
  WriteRegStr HKCU "Software\Rave\Capabilities" "ApplicationDescription" "Navegador web rápido y minimalista"
  WriteRegStr HKCU "Software\Rave\Capabilities\FileAssociations" ".htm"   "RaveBrowser"
  WriteRegStr HKCU "Software\Rave\Capabilities\FileAssociations" ".html"  "RaveBrowser"
  WriteRegStr HKCU "Software\Rave\Capabilities\FileAssociations" ".xhtml" "RaveBrowser"
  WriteRegStr HKCU "Software\Rave\Capabilities\URLAssociations"  "http"   "RaveBrowser"
  WriteRegStr HKCU "Software\Rave\Capabilities\URLAssociations"  "https"  "RaveBrowser"
  WriteRegStr HKCU "Software\Rave\Capabilities\URLAssociations"  "ftp"    "RaveBrowser"

  ; Registro global de aplicaciones predeterminadas
  WriteRegStr HKCU "Software\RegisteredApplications" "Rave" "Software\Rave\Capabilities"

  ; Notificar a Windows del cambio de asociaciones
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\RaveBrowser"
  DeleteRegKey HKCU "Software\Rave"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Rave"
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
