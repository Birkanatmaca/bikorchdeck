' DevDeck: start the agent with no console window. Output goes to devdeck.log in the project root.
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
sh.Run "cmd /c node server\index.js >> devdeck.log 2>&1", 0, False
