; .pixl files get their own document icon instead of the app icon.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\AMxPixl Project\DefaultIcon" "" "$INSTDIR\pixl-file.ico,0"
  ; Tell Explorer file icons changed so it redraws them.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
