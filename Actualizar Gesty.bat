@echo off
rem Gesty Management - descargar la ultima version desde GitHub (doble clic)
chcp 65001 >nul
title Actualizar Gesty Management
cd /d "%~dp0"
echo.

where git >nul 2>nul
if errorlevel 1 goto :sin_git
if not exist .git goto :sin_repo

echo   Descargando la ultima version...
git pull origin main
if errorlevel 1 goto :error_git
echo.
echo   Actualizando dependencias...
call npm install --no-audit --no-fund
if errorlevel 1 goto :error_npm
echo.
echo   Gesty esta actualizado. Ya puedes abrir "Iniciar Gesty.bat".
echo.
pause
exit /b 0

:sin_git
echo   Para actualizar con este archivo hace falta Git: https://git-scm.com/download/win
echo   Tambien puedes descargar el ZIP desde GitHub - boton Code, Download ZIP -
echo   y copiar los archivos encima de esta carpeta, sin borrar la carpeta data.
echo.
pause
exit /b 1

:sin_repo
echo   Esta carpeta no se descargo con Git, asi que no se puede actualizar automaticamente.
echo   Descarga el ZIP desde GitHub - boton Code, Download ZIP - y copia los archivos
echo   encima de esta carpeta, sin borrar la carpeta data. Tus datos estan en data.
echo.
pause
exit /b 1

:error_git
echo.
echo   No se ha podido descargar la actualizacion. Si has cambiado archivos a mano,
echo   copia el texto de esta ventana y envialo.
echo.
pause
exit /b 1

:error_npm
echo.
echo   No se han podido actualizar las dependencias. Comprueba la conexion a internet.
echo.
pause
exit /b 1
