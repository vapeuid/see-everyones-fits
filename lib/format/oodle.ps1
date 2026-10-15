param([string]$Jobs, [string]$Dll, [string]$Out)
# Batch decoder for Frostbite CAS block streams, using the game's own Oodle DLL (never bundled).
# Jobs file: one "<cas path>`t<offset>`t<size>" per line. All decoded payloads are written one after
# another to $Out; stdout gets one line per job: its decoded length, or "ERR <reason>".
# Reads only. Opens archives with full sharing so a running game or launcher is not disturbed.
$ErrorActionPreference = 'Stop'
$src = @"
using System;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
public static class ReskateCas {
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr LoadLibraryExW(string path, IntPtr file, uint flags);
  [DllImport("kernel32", CharSet = CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr module, string name);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
  delegate long OodleDecompress(byte[] src, long srcLen, byte[] dst, long dstLen, int fuzz, int crc, int verbose,
    IntPtr dictBase, long dictSize, IntPtr cb, IntPtr cbData, IntPtr scratch, long scratchSize, int threadPhase);
  static OodleDecompress oodle;
  public static string Init(string dll) {
    // 0x1100 = LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32
    IntPtr h = LoadLibraryExW(dll, IntPtr.Zero, 0x1100);
    if (h == IntPtr.Zero) return "cannot load the game's Oodle DLL (Windows error " + Marshal.GetLastWin32Error() + ")";
    IntPtr f = GetProcAddress(h, "OodleLZ_Decompress");
    if (f == IntPtr.Zero) return "the Oodle DLL has no OodleLZ_Decompress";
    oodle = (OodleDecompress)Marshal.GetDelegateForFunctionPointer(f, typeof(OodleDecompress));
    return null;
  }
  static byte[] Read(string path, long offset, int size) {
    using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
      fs.Seek(offset, SeekOrigin.Begin);
      byte[] b = new byte[size]; int got = 0;
      while (got < size) { int n = fs.Read(b, got, size - got); if (n <= 0) throw new Exception("archive is shorter than its index says"); got += n; }
      return b;
    }
  }
  public static byte[] Decode(string path, long offset, int size, int limit) {
    byte[] e = Read(path, offset, size); int p = 0; var ms = new MemoryStream();
    while (p < e.Length) {
      if (p + 8 > e.Length) throw new Exception("truncated block header");
      // u32 BE: top byte = dictionary flag, low 24 bits = decoded size
      bool dict = e[p] != 0;
      int decoded = (e[p + 1] << 16) | (e[p + 2] << 8) | e[p + 3];
      int comp = e[p + 4] | (e[p + 5] << 8);
      int encoded = ((e[p + 6] << 8) | e[p + 7]) + (((comp >> 8) & 0x0F) << 16);
      comp &= 0x7F; p += 8;
      if (p + encoded > e.Length) throw new Exception("truncated block");
      if (ms.Length + decoded > limit) throw new Exception("payload is larger than the safety limit");
      byte[] o;
      if (comp == 0x00) { if (encoded != decoded) throw new Exception("raw block size mismatch"); o = new byte[encoded]; Buffer.BlockCopy(e, p, o, 0, encoded); }
      else if (comp == 0x11 || comp == 0x15 || comp == 0x19) {
        if (oodle == null) throw new Exception("Oodle is not available");
        byte[] blk = new byte[encoded]; Buffer.BlockCopy(e, p, blk, 0, encoded); o = new byte[decoded];
        if (oodle(blk, encoded, o, decoded, 1, 0, 0, IntPtr.Zero, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, 3) != decoded) throw new Exception("Oodle block did not decode");
      } else if (comp == 0x02) {
        o = new byte[decoded]; int got = 0;
        using (var z = new DeflateStream(new MemoryStream(e, p + 2, encoded - 2), CompressionMode.Decompress))
          while (got < decoded) { int n = z.Read(o, got, decoded - got); if (n <= 0) break; got += n; }
        if (got != decoded) throw new Exception("zlib block did not decode");
      } else throw new Exception("unsupported compression 0x" + comp.ToString("x2") + (dict ? " (dictionary)" : ""));
      ms.Write(o, 0, o.Length); p += encoded;
    }
    return ms.ToArray();
  }
}
"@
Add-Type -TypeDefinition $src -Language CSharp
$init = [ReskateCas]::Init($Dll)
$writer = [System.IO.File]::Open($Out, 'Create', 'Write', 'None')
$stdout = [Console]::Out
try {
  foreach ($line in [System.IO.File]::ReadAllLines($Jobs)) {
    if (-not $line) { continue }
    $a = $line.Split("`t")
    try {
      $bytes = [ReskateCas]::Decode($a[0], [long]$a[1], [int]$a[2], 268435456)
      $writer.Write($bytes, 0, $bytes.Length)
      $stdout.WriteLine($bytes.Length)
    } catch {
      $msg = $_.Exception.Message
      if ($_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }
      if ($init -and $msg -match 'Oodle') { $msg = $init }
      $stdout.WriteLine('ERR ' + ($msg -replace '[\r\n]+', ' '))
    }
  }
} finally { $writer.Close() }
