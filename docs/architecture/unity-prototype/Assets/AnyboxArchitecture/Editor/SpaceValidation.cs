using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using TMPro;
using UnityEngine;
using UnityEngine.EventSystems;

namespace Anybox.ArchitectureLab.Editor
{
    public static class SpaceValidation
    {
        [Serializable] public sealed class Report
        {
            public string status="running";
            public int passed;
            public int inspectedFrames;
            public List<string> failures=new List<string>();
        }
        public static Report LastReport;
        public static void Start()
        {
            if(ArchitectureSpace.Active==null)throw new InvalidOperationException("Enter Play in the 3D scene first.");
            LastReport=new Report();ArchitectureSpace.Active.StartCoroutine(Inspect());
        }
        static void Check(bool valid,string name)
        {
            if(valid)LastReport.passed++;else LastReport.failures.Add(name);
        }
        static void TextFits(ArchitectureSpace space,string label)
        {
            foreach(var text in space.GetComponentsInChildren<TMP_Text>())
            {
                text.ForceMeshUpdate();if(text.isTextOverflowing)LastReport.failures.Add(label+": text overflow: "+text.text);
            }
            LastReport.inspectedFrames++;
        }
        static IEnumerator Inspect()
        {
            var space=ArchitectureSpace.Active;
            Check(!space.WorldCamera.orthographic,"Perspective camera");
            Check(space.NodeVisualCount==12,"Twelve explorable modules");
            Check(space.GetComponentsInChildren<SpacePickTarget>().Length==12,"Twelve physical pick colliders");
            Check(LabValidation.RunAll().passed==92,"Shared simulation: 92 assertions");
            for(int scenario=0;scenario<6;scenario++)
            {
                space.ChooseExperiment(scenario);
                int guard=50;
                while(!space.Simulation.Terminal&&guard-->0)
                {
                    space.Advance();yield return null;
                    TextFits(space,"Scenario "+scenario+" / "+space.Simulation.Index);
                    if(space.Simulation.Current.Mutation==Mutation.Crash&&scenario==3)
                        Check(!space.Simulation.ProcessAlive&&space.Simulation.ScopeActive&&space.Simulation.ExecuteCount==1,"Worker scope survives execution-process loss");
                }
                string expected=scenario==2?"cancelled":scenario==4?"interrupted":scenario==5?"cleanup-failed":"completed";
                Check(space.Simulation.Status==expected,"3D scenario "+scenario+" terminal");
                Check(space.Simulation.Nodes.Count==(expected=="completed"?1:0),"3D scenario "+scenario+" history barrier");
                Check(space.transform.Find("Spatial Architecture").Cast<Transform>().Count(t=>t.name.StartsWith("Successful node N"))==space.Simulation.Nodes.Count,"3D history matches durable nodes / "+scenario);
            }
            space.ChooseExperiment(0);space.SetView(0);yield return new WaitForSecondsRealtime(.7f);
            var runtime=space.NodePosition("runtime");var session=space.NodePosition("session");
            space.ToggleLayers();yield return new WaitForSecondsRealtime(.7f);
            Check(space.NodePosition("runtime").y>runtime.y+2.7f,"Exploded view raises runtime resources");
            Check(Vector3.Distance(space.NodePosition("session"),session)<.001f,"Durable facts retain their base position");
            space.ToggleLayers();yield return new WaitForSecondsRealtime(.7f);
            Check(Vector3.Distance(space.NodePosition("runtime"),runtime)<.02f,"Collapse restores spatial positions");
            foreach(var id in LabContent.Nodes.Keys)
            {
                space.FocusNode(id);yield return new WaitForSecondsRealtime(.6f);Physics.SyncTransforms();
                var point=space.WorldCamera.WorldToScreenPoint(space.NodePosition(id));
                bool hit=Physics.Raycast(space.WorldCamera.ScreenPointToRay(point),out var info,180);
                Check(hit&&info.collider.GetComponent<SpacePickTarget>()?.Id==id,"Focused 3D raycast / "+id);
                Check(space.Selected==id,"Inspector selection / "+id);TextFits(space,"Inspector / "+id);
            }
            space.SetView(0);space.SelectNode("runtime");yield return new WaitForSecondsRealtime(.7f);
            foreach(var button in space.GetComponentsInChildren<UnityEngine.UI.Button>().Where(b=>b.interactable))
            {
                var r=(RectTransform)button.transform;var point=RectTransformUtility.WorldToScreenPoint(null,r.TransformPoint(r.rect.center));
                if(button.GetComponent<SpaceLabelPointer>()!=null&&!space.WorldCamera.pixelRect.Contains(point))continue;
                var data=new PointerEventData(EventSystem.current){position=point};var hits=new List<RaycastResult>();EventSystem.current.RaycastAll(data,hits);
                Check(hits.Count>0&&hits[0].gameObject.GetComponentInParent<UnityEngine.UI.Button>()==button,"Clickable HUD / "+button.name);
            }
            LastReport.status=LastReport.failures.Count==0?"passed":"failed";
            Directory.CreateDirectory("Logs");File.WriteAllText("Logs/space-validation.json",JsonUtility.ToJson(LastReport,true));
            Debug.Log("3D validation "+LastReport.status+": "+LastReport.passed+" checks, "+LastReport.inspectedFrames+" inspected UI states.");
        }
    }
}
