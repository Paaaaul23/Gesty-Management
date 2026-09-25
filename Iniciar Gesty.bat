@echo off
rem Gesty Management - arranque en Windows (doble clic)
chcp 65001 >nul
title Gesty Management
cd /d "%~dp0"

echo.
echo   ====================================
echo            GESTY MANAGEMENT
echo   ====================================
echo.

rem 1. Node.js instalado
where node >nul 2>nul
if errorlevel 1 goto :sin_node

rem 2. Version de Node.js y dependencias al dia
node scripts\preflight.js
if errorlevel 3 goto :error
if errorlevel 1 goto :instalar
goto :datos

:instalar
echo   Instalando o actualizando dependencias. La primera vez tarda unos minutos...
echo.
call npm install --no-audit --no-fund
if errorlevel 1 goto :error_npm
node scripts\preflight.js
if errorlevel 1 goto :error_npm

:datos
rem 3. Base de datos con los usuarios iniciales
if exist data\gesty.db goto :arrancar
echo.
echo   Creando la base de datos por primera vez...
call npm run seed
if errorlevel 1 goto :error
echo.
echo   IMPORTANTE: apunta las credenciales que aparecen arriba.
echo   No se vuelven a mostrar.
echo.
pause

:arrancar
rem 4. Servidor. El navegador se abre solo cuando esta listo.
set GESTY_OPEN=1
node server.js
echo.
echo   Gesty se ha detenido.
pause
exit /b 0

:sin_node
echo   No se ha encontrado Node.js en este ordenador.
echo.
echo   1. Se va a abrir la web de descarga: elige la version LTS para Windows.
echo   2. Instalala con las opciones por defecto.
echo   3. Vuelve a abrir este archivo.
echo.
start "" https://nodejs.org/es/download
pause
exit /b 1

:error_npm
echo.
echo   No se han podido instalar las dependencias.
echo   Comprueba la conexion a internet y vuelve a intentarlo.
echo   Si sigue fallando, copia el texto de esta ventana y envialo.
echo.
pause
exit /b 1

:error
echo.
echo   Gesty no ha podido arrancar. Revisa el mensaje de arriba.
echo.
pause
exit /b 1
