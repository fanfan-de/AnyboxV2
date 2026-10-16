using System;
using System.IO;
using System.Linq;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Anybox.ArchitectureLab.Editor
{
    public static class LabEditor
    {
        const string Folder = "Assets/AnyboxArchitecture";
        public const string ScenePath = Folder + "/AnyboxArchitectureLab.unity";

        [MenuItem("Anybox/Architecture Lab/Create or Open")]
        public static void CreateOrOpen()
        {
            if (EditorApplication.isPlaying) throw new InvalidOperationException("Stop Play mode before opening the saved scene.");
            if (SceneManager.GetActiveScene().isDirty) throw new InvalidOperationException("Save the active scene before creating the lab.");
            if (File.Exists(ScenePath)) { EditorSceneManager.OpenScene(ScenePath); return; }
            var font = PrepareFont();
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var cameraObject = new GameObject("Presentation Camera", typeof(Camera), typeof(AudioListener));
            var camera = cameraObject.GetComponent<Camera>();camera.clearFlags=CameraClearFlags.SolidColor;camera.backgroundColor=new Color(.063f,.094f,.118f);camera.orthographic=true;
            cameraObject.tag="MainCamera";cameraObject.transform.position=new Vector3(0,0,-10);
            var root = new GameObject("Anybox Architecture Lab");
            root.AddComponent<ArchitectureLab>().Font=font;
            EditorSceneManager.SaveScene(scene,ScenePath);
            EditorBuildSettings.scenes = EditorBuildSettings.scenes.Concat(new[] {new EditorBuildSettingsScene(ScenePath,true)}).GroupBy(s=>s.path).Select(g=>g.First()).ToArray();
            Selection.activeGameObject=root;AssetDatabase.SaveAssets();
            Debug.Log("Anybox Architecture Lab created. Enter Play mode to explore.");
        }

        public static TMP_FontAsset PrepareFont()
        {
            var assetPath=Folder+"/LabCJK.asset";
            var lab=UnityEngine.Object.FindAnyObjectByType<ArchitectureLab>();
            var font=lab!=null&&lab.Font!=null?lab.Font:AssetDatabase.LoadAssetAtPath<TMP_FontAsset>(assetPath);
            var characters=string.Concat(Directory.GetFiles(Folder,"*.cs",SearchOption.AllDirectories).Select(File.ReadAllText));
            characters+= "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz →×●○/·—";
            characters=new string(characters.Where(c=>!char.IsControl(c)&&!char.IsSurrogate(c)).Distinct().ToArray());
            if(font!=null&&characters.All(c=>font.HasCharacter(c)))return font;
            // Static atlases no longer retain a live OS font face after reload.
            // Bake a fresh revision when new glyphs are needed, preserving the old asset.
            if(font!=null)assetPath=AssetDatabase.GenerateUniqueAssetPath(assetPath);
            font=TMP_FontAsset.CreateFontAsset("Microsoft YaHei","Regular",64);
            if(font==null)font=TMP_FontAsset.CreateFontAsset("DengXian","Regular",64);
            if(font==null)throw new InvalidOperationException("A Chinese system font is required to bake the local preview font.");
            font.name="Anybox Lab CJK";
            font.isMultiAtlasTexturesEnabled=true;
            font.TryAddCharacters(characters,out string missing);
            if(!string.IsNullOrEmpty(missing))throw new InvalidOperationException("Missing font glyphs: "+missing);
            font.atlasPopulationMode=AtlasPopulationMode.Static;
            AssetDatabase.CreateAsset(font,assetPath);
            if(font.material!=null&&!AssetDatabase.Contains(font.material))AssetDatabase.AddObjectToAsset(font.material,font);
            foreach(var atlas in font.atlasTextures)if(atlas!=null&&!AssetDatabase.Contains(atlas))AssetDatabase.AddObjectToAsset(atlas,font);
            EditorUtility.SetDirty(font);AssetDatabase.SaveAssets();
            if(lab!=null&&lab.gameObject.scene.path==ScenePath)
            {
                lab.Font=font;EditorUtility.SetDirty(lab);
                EditorSceneManager.MarkSceneDirty(lab.gameObject.scene);
                EditorSceneManager.SaveScene(lab.gameObject.scene);
            }
            Debug.Log("Local CJK atlas baked: "+characters.Length+" characters; missing="+missing);
            return font;
        }

        [MenuItem("Anybox/Architecture Lab/Validate Simulation")]
        public static void ValidateMenu() { Debug.Log(JsonUtility.ToJson(LabValidation.RunAll(),true)); }

        [MenuItem("Anybox/Architecture Lab/Build Local Player")]
        public static void BuildPlayer()
        {
            var output=Path.GetFullPath("Builds/AnyboxArchitectureLab/AnyboxArchitectureLab.exe");
            Directory.CreateDirectory(Path.GetDirectoryName(output));
            var previousWidth=PlayerSettings.defaultScreenWidth;var previousHeight=PlayerSettings.defaultScreenHeight;
            var previousMode=PlayerSettings.fullScreenMode;var previousResize=PlayerSettings.resizableWindow;
            try
            {
                PlayerSettings.defaultScreenWidth=1440;PlayerSettings.defaultScreenHeight=900;PlayerSettings.fullScreenMode=FullScreenMode.Windowed;PlayerSettings.resizableWindow=true;
                var report=BuildPipeline.BuildPlayer(new BuildPlayerOptions { scenes=new[]{ScenePath},locationPathName=output,target=BuildTarget.StandaloneWindows64,options=BuildOptions.None });
                if(report.summary.result!=UnityEditor.Build.Reporting.BuildResult.Succeeded)throw new InvalidOperationException("Player build failed: "+report.summary.result);
                Debug.Log("Local prototype player built: "+output);
            }
            finally
            {
                PlayerSettings.defaultScreenWidth=previousWidth;PlayerSettings.defaultScreenHeight=previousHeight;PlayerSettings.fullScreenMode=previousMode;PlayerSettings.resizableWindow=previousResize;
            }
        }
    }
}
