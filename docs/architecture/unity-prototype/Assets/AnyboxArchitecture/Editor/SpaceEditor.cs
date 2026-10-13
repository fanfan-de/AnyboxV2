using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.SceneManagement;

namespace Anybox.ArchitectureLab.Editor
{
    public static class SpaceEditor
    {
        public const string ScenePath="Assets/AnyboxArchitecture/AnyboxArchitecture3D.unity";

        [MenuItem("Anybox/Architecture Space/Create or Open 3D")]
        public static void CreateOrOpen()
        {
            if(EditorApplication.isPlaying)throw new InvalidOperationException("Stop Play mode first.");
            if(SceneManager.GetActiveScene().isDirty)throw new InvalidOperationException("Save the current scene before opening the 3D prototype.");
            if(File.Exists(ScenePath)){EditorSceneManager.OpenScene(ScenePath);RefreshAssets();return;}
            var font=LabEditor.PrepareFont();
            int renderer=EnsureForwardRenderer();
            var scene=EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);
            var backdrop=new GameObject("Backdrop Camera",typeof(Camera));var backCamera=backdrop.GetComponent<Camera>();
            backCamera.clearFlags=CameraClearFlags.SolidColor;backCamera.backgroundColor=new Color(12/255f,21/255f,29/255f);backCamera.cullingMask=0;backCamera.depth=-10;
            backCamera.GetUniversalAdditionalCameraData().SetRenderer(renderer);
            var cameraObject=new GameObject("Orbit Camera",typeof(Camera),typeof(AudioListener));cameraObject.tag="MainCamera";
            var camera=cameraObject.GetComponent<Camera>();camera.clearFlags=CameraClearFlags.SolidColor;camera.backgroundColor=backCamera.backgroundColor;
            camera.fieldOfView=43;camera.nearClipPlane=.1f;camera.farClipPlane=160;camera.depth=0;camera.allowHDR=true;
            camera.GetUniversalAdditionalCameraData().SetRenderer(renderer);
            camera.transform.position=new Vector3(9,34,-36);camera.transform.LookAt(new Vector3(0,1,0));
            var lightObject=new GameObject("Key soft light",typeof(Light));var light=lightObject.GetComponent<Light>();
            light.type=LightType.Directional;light.intensity=1.5f;light.color=new Color(.91f,.96f,1);light.shadows=LightShadows.Soft;light.shadowStrength=.65f;lightObject.transform.rotation=Quaternion.Euler(46,-38,0);
            var fillObject=new GameObject("Warm rim light",typeof(Light));var fill=fillObject.GetComponent<Light>();fill.type=LightType.Directional;fill.intensity=.55f;fill.color=new Color(.85f,.90f,1);fillObject.transform.rotation=Quaternion.Euler(30,145,0);
            RenderSettings.ambientMode=AmbientMode.Flat;RenderSettings.ambientLight=new Color(.46f,.53f,.65f);RenderSettings.skybox=null;RenderSettings.fog=false;
            var root=new GameObject("Anybox Architecture Space");var space=root.AddComponent<ArchitectureSpace>();space.Font=font;space.WorldCamera=camera;
            EditorSceneManager.SaveScene(scene,ScenePath);
            EditorBuildSettings.scenes=EditorBuildSettings.scenes.Concat(new[]{new EditorBuildSettingsScene(ScenePath,true)}).GroupBy(s=>s.path).Select(g=>g.First()).ToArray();
            Selection.activeGameObject=root;AssetDatabase.SaveAssets();
            RefreshAssets();
            Debug.Log("3D architecture scene created. Press Play to orbit and explore.");
        }

        [MenuItem("Anybox/Architecture Space/Refresh Scene Assets")]
        public static void RefreshAssets()
        {
            if(EditorApplication.isPlaying)throw new InvalidOperationException("Stop Play before refreshing scene assets.");
            var space=UnityEngine.Object.FindAnyObjectByType<ArchitectureSpace>();
            if(space==null||space.gameObject.scene.path!=ScenePath)throw new InvalidOperationException("Open the 3D prototype scene first.");
            Material Template(string name,string shader)
            {
                string path="Assets/AnyboxArchitecture/"+name+".mat";var material=AssetDatabase.LoadAssetAtPath<Material>(path);
                if(material==null){material=new Material(Shader.Find(shader));material.name=name;AssetDatabase.CreateAsset(material,path);}return material;
            }
            // Serialized templates retain the shaders and used variants in standalone builds.
            space.SurfaceTemplate=Template("Space Surface","Universal Render Pipeline/Lit");
            space.SignalTemplate=Template("Space Signal","Universal Render Pipeline/Unlit");
            space.GroundTemplate=Template("Space Ground","Universal Render Pipeline/Lit");
            space.GroundTemplate.SetFloat("_EnvironmentReflections",0);space.GroundTemplate.EnableKeyword("_ENVIRONMENTREFLECTIONS_OFF");
            EditorUtility.SetDirty(space.GroundTemplate);EditorUtility.SetDirty(space);AssetDatabase.SaveAssets();EditorSceneManager.SaveScene(space.gameObject.scene);
        }

        static int EnsureForwardRenderer()
        {
            const string path="Assets/AnyboxArchitecture/SpaceForwardRenderer.asset";
            var renderer=AssetDatabase.LoadAssetAtPath<UniversalRendererData>(path);
            if(renderer==null)
            {
                var template=AssetDatabase.LoadAssetAtPath<UniversalRendererData>("Packages/com.unity.render-pipelines.universal/Runtime/Data/UniversalRendererData.asset");
                if(template==null)throw new InvalidOperationException("URP forward renderer template is unavailable.");
                renderer=UnityEngine.Object.Instantiate(template);renderer.name="Anybox Space Forward";AssetDatabase.CreateAsset(renderer,path);
            }
            var pipeline=GraphicsSettings.currentRenderPipeline as UniversalRenderPipelineAsset;
            if(pipeline==null)throw new InvalidOperationException("The 3D prototype expects the existing URP project.");
            // Keep the original default 2D renderer. Only the new cameras use this entry.
            var serialized=new SerializedObject(pipeline);var list=serialized.FindProperty("m_RendererDataList");
            for(int i=0;i<list.arraySize;i++)if(list.GetArrayElementAtIndex(i).objectReferenceValue==renderer)return i;
            int index=list.arraySize;list.InsertArrayElementAtIndex(index);list.GetArrayElementAtIndex(index).objectReferenceValue=renderer;serialized.ApplyModifiedProperties();EditorUtility.SetDirty(pipeline);AssetDatabase.SaveAssets();return index;
        }

        [MenuItem("Anybox/Architecture Space/Build 3D Player")]
        public static void BuildPlayer()
        {
            var output=Path.GetFullPath("Builds/AnyboxArchitecture3D/AnyboxArchitecture3D.exe");Directory.CreateDirectory(Path.GetDirectoryName(output));
            int width=PlayerSettings.defaultScreenWidth,height=PlayerSettings.defaultScreenHeight;var mode=PlayerSettings.fullScreenMode;bool resize=PlayerSettings.resizableWindow;string product=PlayerSettings.productName;
            try
            {
                PlayerSettings.defaultScreenWidth=1600;PlayerSettings.defaultScreenHeight=1000;PlayerSettings.fullScreenMode=FullScreenMode.Windowed;PlayerSettings.resizableWindow=true;PlayerSettings.productName="Anybox Architecture Space";
                var report=BuildPipeline.BuildPlayer(new BuildPlayerOptions{scenes=new[]{ScenePath},locationPathName=output,target=BuildTarget.StandaloneWindows64,options=BuildOptions.None});
                if(report.summary.result!=UnityEditor.Build.Reporting.BuildResult.Succeeded)throw new InvalidOperationException("3D player build failed: "+report.summary.result);
                Debug.Log("3D player built: "+output+"; errors="+report.summary.totalErrors+"; warnings="+report.summary.totalWarnings);
            }
            finally{PlayerSettings.defaultScreenWidth=width;PlayerSettings.defaultScreenHeight=height;PlayerSettings.fullScreenMode=mode;PlayerSettings.resizableWindow=resize;PlayerSettings.productName=product;}
        }
    }
}
