$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class DialogCancellationFixture {
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr window; public uint message; public UIntPtr wparam; public IntPtr lparam; public uint time; public Point point; public uint extra; }
    delegate IntPtr WindowProcedure(IntPtr window, uint message, UIntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateWindowExW(uint exStyle, string className, string title, uint style, int x, int y, int width, int height, IntPtr owner, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowLongPtrW(IntPtr window, int index, WindowProcedure procedure);
    [DllImport("user32.dll")] static extern IntPtr CallWindowProcW(IntPtr previous, IntPtr window, uint message, UIntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] static extern int GetMessageW(out Message message, IntPtr window, uint minimum, uint maximum);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref Message message);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);
    static readonly Dictionary<IntPtr, IntPtr> Previous = new Dictionary<IntPtr, IntPtr>();
    static readonly Dictionary<IntPtr, string> Names = new Dictionary<IntPtr, string>();
    static readonly WindowProcedure Procedure = Receive;

    static IntPtr Receive(IntPtr window, uint message, UIntPtr wparam, IntPtr lparam) {
        if (message == 0x0010) {
            Console.WriteLine("{\"closed\":\"" + Names[window] + "\"}");
            Console.Out.Flush();
            DestroyWindow(window);
            return IntPtr.Zero;
        }
        return CallWindowProcW(Previous[window], window, message, wparam, lparam);
    }
    static IntPtr Create(string name, string className, IntPtr owner) {
        // No WS_VISIBLE: the isolation test creates no visible desktop UI.
        IntPtr window = CreateWindowExW(0, className, name, 0x80000000, 0, 0, 100, 100, owner, IntPtr.Zero, GetModuleHandleW(null), IntPtr.Zero);
        if (window == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        Names.Add(window, name);
        IntPtr previous = SetWindowLongPtrW(window, -4, Procedure);
        if (previous == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        Previous.Add(window, previous);
        return window;
    }
    public static void Start() {
        IntPtr owner = Create("owner", "STATIC", IntPtr.Zero);
        IntPtr otherOwner = Create("other-owner", "STATIC", IntPtr.Zero);
        Create("target-dialog", "#32770", owner);
        Create("other-dialog", "#32770", otherOwner);
        Create("other-class", "STATIC", owner);
        Console.WriteLine("{\"owner\":\"" + owner.ToInt64() + "\",\"pid\":" + Process.GetCurrentProcess().Id + "}");
        Console.Out.Flush();
        Message message;
        while (GetMessageW(out message, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref message); DispatchMessageW(ref message); }
    }
}
'@
[DialogCancellationFixture]::Start()
