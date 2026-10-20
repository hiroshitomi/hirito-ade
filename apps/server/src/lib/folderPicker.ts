import { execa } from 'execa';

const TITLE = 'ADE · Elige la carpeta del proyecto';

/**
 * Comandos que abren el selector de carpetas nativo del sistema y escriben la ruta
 * elegida en stdout (vacío o código ≠ 0 si se cancela). ADE corre en tu máquina,
 * así que el diálogo aparece en tu escritorio. En orden de preferencia.
 */
export function pickerCommands(platform: NodeJS.Platform): { command: string; args: string[] }[] {
  if (platform === 'win32') {
    // Windows PowerShell 5.1 (.NET Framework): solo propiedades clásicas del diálogo.
    // Formulario TopMost como dueño: si no, el diálogo puede abrirse detrás del navegador.
    const script = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$d.Description = '${TITLE}'`,
      '$d.ShowNewFolderButton = $false',
      "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
    ].join('; ');
    return [{ command: 'powershell.exe', args: ['-NoProfile', '-STA', '-Command', script] }];
  }
  if (platform === 'darwin') {
    return [{ command: 'osascript', args: ['-e', `POSIX path of (choose folder with prompt "${TITLE}")`] }];
  }
  return [
    { command: 'zenity', args: ['--file-selection', '--directory', `--title=${TITLE}`] },
    { command: 'kdialog', args: ['--getexistingdirectory', '.', '--title', TITLE] },
  ];
}

export type PickResult = { status: 'picked'; path: string } | { status: 'cancelled' } | { status: 'unsupported' };

/**
 * Abre el diálogo nativo. 'unsupported' si no hay ninguno disponible (p.ej. Linux sin
 * zenity/kdialog): la UI recurre entonces al navegador de carpetas integrado.
 */
export async function pickFolder(
  platform: NodeJS.Platform = process.platform,
  commands = pickerCommands(platform),
): Promise<PickResult> {
  for (const { command, args } of commands) {
    const res = await execa(command, args, { reject: false, timeout: 10 * 60 * 1000 });
    if ((res as { code?: string }).code === 'ENOENT') continue; // no instalado: probar el siguiente
    const picked = (res.stdout ?? '').trim();
    // En macOS, osascript devuelve la ruta con "/" final.
    if (res.exitCode === 0 && picked) return { status: 'picked', path: picked.replace(/(.)\/$/, '$1') };
    return { status: 'cancelled' };
  }
  return { status: 'unsupported' };
}
