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
