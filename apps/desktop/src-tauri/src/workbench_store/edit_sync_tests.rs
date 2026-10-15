use super::*;

fn fixture() -> WorkbenchStore {
    let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../sandbox/edit-sync-conflict-20261014/native-tests").join(unique());
    fs::create_dir_all(&root).unwrap();
    let source=root.join("source.json");
    fs::write(&source,json!({"revision":7,"configs":[{"id":"a","shopId":"intel","productId":"p","parts":[{"slot":"CPU","goodsId":"g","qty":1,"taxOverride":null}],"actualParts":[{"slot":"CPU","goodsId":"g","qty":1,"taxOverride":null}]}],"templates":[],"logs":[]}).to_string()).unwrap();
    initialize(&root.join("workbench.sqlite"),&source,&root.join("assets")).unwrap()
}

#[test]
fn edit_sync_null_override_patch_and_batch_accept_but_real_conflict_is_atomic() {
    for endpoint in ["/api/configs/patch","/api/configs/batch"] {
        for mode in [None,Some("ordinary")] {
            if endpoint.ends_with("patch") && mode.is_none(){continue;}
            let s=fixture();let c=db(&s.path).unwrap();let mut before=state(&c).unwrap();
            let mut second=before["configs"][0].clone();second["id"]=json!("b");before["configs"].as_array_mut().unwrap().push(second);
            replace_fixture(&c,&before);
            let mut current=before.clone();
            for config in current["configs"].as_array_mut().unwrap() {for field in ["parts","actualParts"] {config[field][0].as_object_mut().unwrap().remove("taxOverride");}}
            current["revision"]=json!(8);replace_fixture(&c,&current);
            let changes:Vec<Value>=before["configs"].as_array().unwrap().iter().map(|base|{
                let mut desired=base.clone();for field in ["parts","actualParts"] {desired[field][0]["qty"]=json!(2);}
                json!({"id":base["id"],"base":base,"after":desired})
            }).collect();
            let mut input=json!({"operationId":"edit","baseRevision":7,"changes":changes});
            if let Some(mode)=mode {input["mode"]=json!(mode);}
            let response=request(&s,"POST",endpoint,Some(&input.to_string())).unwrap();
            assert_eq!(response.status,200,"{endpoint}: {}",response.body);
            let saved=state(&c).unwrap();assert_eq!(saved["configs"][0]["parts"][0]["qty"],2);
            assert_eq!(saved["configs"][1]["parts"][0]["qty"],2);
            input["operationId"]=json!("competing");
            input["changes"][0]["base"]=saved["configs"][0].clone();input["changes"][0]["after"]=saved["configs"][0].clone();
            input["changes"][0]["after"]["parts"][0]["qty"]=json!(4);
            input["changes"][1]["after"]["parts"][0]["qty"]=json!(3);
            assert_eq!(request(&s,"POST",endpoint,Some(&input.to_string())).unwrap().status,409);
            assert_eq!(state(&c).unwrap(),saved);
        }
    }
}

#[test]
fn edit_sync_full_config_null_override_merges_and_real_override_conflicts() {
    let base=json!([{"id":"a","parts":[{"goodsId":"g","qty":1,"taxOverride":null}]}]);
    let mut current=base.clone();current[0]["parts"][0].as_object_mut().unwrap().remove("taxOverride");
    let mut desired=base.clone();desired[0]["parts"][0]["qty"]=json!(2);
    assert_eq!(merge_configs(&base,&desired,&current).unwrap()[0]["parts"][0]["qty"],2);
    desired[0]["parts"][0]["taxOverride"]=json!({"goodsId":"g","value":20});
    current[0]["parts"][0]["taxOverride"]=json!({"goodsId":"g","value":30});
    assert!(merge_configs(&base,&desired,&current).is_err());
    // Outside direct component rows, missing and null still differ.
    let b=json!([{"id":"a","custom":{"taxOverride":null}}]);
    let l=json!([{"id":"a","custom":{"taxOverride":2}}]);
    let r=json!([{"id":"a","custom":{}}]);
    assert!(merge_configs(&b,&l,&r).is_err());
}


#[test]
fn numeric_baseline_accepts_javascript_integer_roundtrip() {
    for endpoint in ["/api/configs/patch", "/api/configs/batch"] {
        let store=fixture();let c=db(&store.path).unwrap();let mut current=state(&c).unwrap();
        for field in ["parts","actualParts"] {current["configs"][0][field][0]["stockAvailable"]=json!(227.0);current["configs"][0][field][0]["erp"]=json!(9700.0);}
        replace_fixture(&c,&current);
        let mut base=current["configs"][0].clone();
        for field in ["parts","actualParts"] {base[field][0]["stockAvailable"]=json!(227);base[field][0]["erp"]=json!(9700);}
        let mut after=base.clone();for field in ["parts","actualParts"] {after[field][0]["goodsId"]=json!("new");}
        let input=json!({"operationId":"numeric-baseline","mode":"ordinary","baseRevision":7,"changes":[{"id":"a","base":base,"after":after}]});
        let result=request(&store,"POST",endpoint,Some(&input.to_string())).unwrap();
        assert_eq!(result.status,200,"{endpoint}: {}",result.body);
        assert_eq!(state(&c).unwrap()["configs"][0]["parts"][0]["goodsId"],"new");
    }
}

#[test]
fn numeric_baseline_preserves_real_conflicts_and_large_ids() {
    assert!(same_json(&json!({"a":[227.0,-1.0]}),&json!({"a":[227,-1]})));
    for (a,b) in [(json!(9007199254740993u64),json!(9007199254740992.0)),(json!("227"),json!(227)),(json!({"x":null}),json!({})),(json!([1,2]),json!([2,1]))] {assert!(!same_json(&a,&b));}
    let base=json!({"parts":[{"erp":9700,"qty":1}]});let desired=json!({"parts":[{"erp":9700,"qty":2}]});let current=json!({"parts":[{"erp":9700.0,"qty":3}]});
    assert!(merge_configuration(Some(&base),Some(&desired),Some(&current)).is_err());
}
