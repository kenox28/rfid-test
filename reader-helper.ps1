# Reader helper (Windows only). Started automatically by server.js.
# USB keyboard-type RFID readers all "type" into the same keyboard stream, so a web page
# can't tell which reader a card came from. This listens to Windows Raw Input, which
# reports the device each keystroke came from, and prints one line per scan:
#   SCAN<TAB><device path><TAB><card number>
# It only reports fast bursts ending in Enter (how readers type); normal typing is ignored.
# It never writes to disk or the network.

$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public class RawReaderWindow : NativeWindow
{
    const int WM_INPUT = 0x00FF;
    const uint RIM_TYPEKEYBOARD = 1;
    const uint RID_INPUT = 0x10000003;
    const uint RIDI_DEVICENAME = 0x20000007;
    const uint RIDEV_INPUTSINK = 0x00000100;
    const ushort RI_KEY_BREAK = 1;
    const int MAX_GAP_MS = 60;   // readers type a key every ~5-20 ms; people are much slower

    [StructLayout(LayoutKind.Sequential)]
    struct RAWINPUTDEVICE { public ushort usUsagePage; public ushort usUsage; public uint dwFlags; public IntPtr hwndTarget; }

    [StructLayout(LayoutKind.Sequential)]
    struct RAWINPUTHEADER { public uint dwType; public uint dwSize; public IntPtr hDevice; public IntPtr wParam; }

    [StructLayout(LayoutKind.Sequential)]
    struct RAWKEYBOARD { public ushort MakeCode; public ushort Flags; public ushort Reserved; public ushort VKey; public uint Message; public uint ExtraInformation; }

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] devices, uint count, uint size);

    [DllImport("user32.dll")]
    static extern uint GetRawInputData(IntPtr hRawInput, uint command, IntPtr data, ref uint size, uint headerSize);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern uint GetRawInputDeviceInfo(IntPtr hDevice, uint command, StringBuilder data, ref uint size);

    readonly Dictionary<IntPtr, StringBuilder> buffers = new Dictionary<IntPtr, StringBuilder>();
    readonly Dictionary<IntPtr, int> lastKey = new Dictionary<IntPtr, int>();
    readonly Dictionary<IntPtr, string> names = new Dictionary<IntPtr, string>();

    public RawReaderWindow()
    {
        CreateHandle(new CreateParams());
        RAWINPUTDEVICE[] devices = new RAWINPUTDEVICE[1];
        devices[0].usUsagePage = 0x01;           // generic desktop
        devices[0].usUsage = 0x06;               // keyboard
        devices[0].dwFlags = RIDEV_INPUTSINK;    // receive input even when not focused
        devices[0].hwndTarget = this.Handle;
        if (!RegisterRawInputDevices(devices, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE))))
        {
            throw new Exception("RegisterRawInputDevices failed, error " + Marshal.GetLastWin32Error());
        }
        Emit("READY");
    }

    static void Emit(string line)
    {
        Console.Out.WriteLine(line);
        Console.Out.Flush();
    }

    string DeviceName(IntPtr device)
    {
        string name;
        if (names.TryGetValue(device, out name)) return name;
        uint size = 0;
        GetRawInputDeviceInfo(device, RIDI_DEVICENAME, null, ref size);
        StringBuilder sb = new StringBuilder((int)size + 1);
        GetRawInputDeviceInfo(device, RIDI_DEVICENAME, sb, ref size);
        name = sb.ToString().Replace("\t", " ");
        names[device] = name;
        return name;
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_INPUT)
        {
            try { OnRawInput(m.LParam); }
            catch (Exception e) { Emit("ERROR\t" + e.Message.Replace("\t", " ").Replace("\r", " ").Replace("\n", " ")); }
        }
        base.WndProc(ref m);
    }

    void OnRawInput(IntPtr lParam)
    {
        uint headerSize = (uint)Marshal.SizeOf(typeof(RAWINPUTHEADER));
        uint size = 0;
        GetRawInputData(lParam, RID_INPUT, IntPtr.Zero, ref size, headerSize);
        if (size == 0) return;
        IntPtr buffer = Marshal.AllocHGlobal((int)size);
        try
        {
            if (GetRawInputData(lParam, RID_INPUT, buffer, ref size, headerSize) != size) return;
            RAWINPUTHEADER header = (RAWINPUTHEADER)Marshal.PtrToStructure(buffer, typeof(RAWINPUTHEADER));
            if (header.dwType != RIM_TYPEKEYBOARD || header.hDevice == IntPtr.Zero) return; // zero = injected input
            RAWKEYBOARD kb = (RAWKEYBOARD)Marshal.PtrToStructure(new IntPtr(buffer.ToInt64() + headerSize), typeof(RAWKEYBOARD));
            if ((kb.Flags & RI_KEY_BREAK) != 0) return; // key release

            IntPtr dev = header.hDevice;
            StringBuilder sb;
            if (!buffers.TryGetValue(dev, out sb)) { sb = new StringBuilder(); buffers[dev] = sb; }
            int now = Environment.TickCount;
            int last;
            if (lastKey.TryGetValue(dev, out last) && unchecked(now - last) > MAX_GAP_MS) sb.Clear();
            lastKey[dev] = now;

            int vk = kb.VKey;
            if (vk == 0x0D)                                       // Enter ends a scan
            {
                if (sb.Length >= 4) Emit("SCAN\t" + DeviceName(dev) + "\t" + sb.ToString());
                sb.Clear();
            }
            else if (vk >= 0x30 && vk <= 0x39) { if (sb.Length < 64) sb.Append((char)vk); }               // 0-9
            else if (vk >= 0x60 && vk <= 0x69) { if (sb.Length < 64) sb.Append((char)('0' + vk - 0x60)); } // numpad 0-9
            else if (vk >= 0x41 && vk <= 0x5A) { if (sb.Length < 64) sb.Append((char)vk); }               // A-Z (hex UIDs)
            else if (vk != 0x10 && vk != 0xA0 && vk != 0xA1) sb.Clear();                                    // ignore Shift only
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }
}
'@

$null = New-Object RawReaderWindow
[System.Windows.Forms.Application]::Run()
