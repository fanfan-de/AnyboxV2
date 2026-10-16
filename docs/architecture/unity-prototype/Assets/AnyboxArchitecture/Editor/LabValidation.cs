using System;
using System.Collections.Generic;

namespace Anybox.ArchitectureLab.Editor
{
    public static class LabValidation
    {
        [Serializable] public sealed class Report { public int passed; public string[] checks; }
        public static Report RunAll()
        {
            var checks=new List<string>();
            void Check(bool valid,string label) { if(!valid)throw new InvalidOperationException("Lab validation: "+label);checks.Add(label); }
            void Finish(LabSimulation s)
            {
                int guard=100;
                while(s.Advance() && guard-->0)
                    if(s.Nodes.Count>0 && !s.Terminal)throw new InvalidOperationException("Node appeared before terminal settlement.");
                if(guard<=0)throw new InvalidOperationException("Simulation did not settle.");
            }
            for(int protocol=0;protocol<4;protocol++)
            {
                for(int experiment=0;experiment<6;experiment++)
                {
                    var s=new LabSimulation();s.SetProtocol(protocol);s.Reset((Experiment)experiment);Finish(s);
                    string expected=experiment==2?"cancelled":experiment==4?"interrupted":experiment==5?"cleanup-failed":"completed";
                    Check(s.Status==expected,"Protocol "+protocol+" / experiment "+experiment+" / terminal "+expected);
                    Check(s.Nodes.Count==(expected=="completed"?1:0),"Protocol "+protocol+" / experiment "+experiment+" / success-node boundary");
                    if(experiment!=5)Check(s.LiveResources==0,"Protocol "+protocol+" / experiment "+experiment+" / actual exit");
                    if(experiment==3)Check(s.ExecuteCount==1&&s.OwnerEpoch==2,"Recovery queries original operation exactly once / "+protocol);
                    if(experiment==4)Check(s.ExecuteCount==0&&!s.ResponseSaved,"No replay in model-pending / "+protocol);
                    if(experiment==5)Check(s.ScopeActive&&s.Nodes.Count==0,"Unproven scope exit retains ownership / "+protocol);
                    if(experiment==1)Check(!s.ViewOpen&&s.Status=="completed","Closing observation does not cancel / "+protocol);
                }
            }
            var model=new LabSimulation();model.UsesTools=false;model.Reset(Experiment.Success);Finish(model);
            Check(model.ExecuteCount==0&&model.Nodes.Count==1,"Pure model Run never activates worker");
            var offline=new LabSimulation();offline.CatalogOnline=false;Finish(offline);
            Check(offline.Status=="completed","Saved model config works with catalog offline");
            var cancel=new LabSimulation();while(cancel.Current?.Mutation!=Mutation.Dispatch)cancel.Advance();
            Check(cancel.RequestCancel()&&cancel.Status=="cancelling"&&cancel.LiveResources>0,"Cancel request does not claim actual exit");
            Finish(cancel);Check(cancel.ExecuteCount==1&&cancel.Nodes.Count==0&&cancel.LiveResources==0,"Cancellation preserves tool facts and waits for exit");
            var early=new LabSimulation();while(early.Current?.Mutation!=Mutation.ModelStart)early.Advance();early.RequestCancel();Finish(early);
            Check(early.Status=="cancelled"&&early.ExecuteCount==0,"Model cancellation has no fabricated tool effects");
            var branch=new LabSimulation();Finish(branch);branch.SelectParent(0);branch.StartNextRun();while(branch.Advance()){}
            Check(branch.Nodes.Count==2&&branch.Nodes[0].Parent==0&&branch.Nodes[1].Parent==0,"Two successful Runs can share one explicit parent");
            branch.SelectParent(1);branch.StartNextRun();branch.Advance();branch.Advance();
            Check(!branch.SelectParent(0)&&!branch.SetProtocol(3),"Accepted Run locks parent and protocol");
            while(branch.Advance()){}
            Check(branch.Nodes[2].Parent==1&&branch.Nodes[0].Parent==0,"Selected successful path is used; previous nodes remain immutable");
            return new Report { passed=checks.Count,checks=checks.ToArray() };
        }
    }
}
