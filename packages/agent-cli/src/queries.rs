//! CLI 与 MCP 使用相同的查询参数、分页约束和库存快照身份。
use super::{operation_id, request};
use clap::{Args, Subcommand};
use diytools_agent_core::{AgentError, Request};
use serde_json::{json, Value};

#[derive(Debug, Args)]
pub struct SourceFind {
    #[arg(long, alias = "shop")]
    shop_id: String,
    #[arg(long)]
    query: Option<String>,
    #[arg(long)]
    category: Option<String>,
    #[arg(long, value_parser=["in_stock","incoming","out","unknown"])]
    stock_status: Option<String>,
    #[arg(long)]
    min_price: Option<f64>,
    #[arg(long)]
    max_price: Option<f64>,
    #[arg(long, value_parser=["all","diff","upgrade","shortage","missing_tax","deleted"])]
    filter: Option<String>,
    #[arg(long)]
    include_deleted: bool,
    #[arg(long,default_value_t=20,value_parser=clap::value_parser!(u32).range(1..=100))]
    limit: u32,
    #[arg(long, default_value_t = 0)]
    offset: u64,
    #[arg(long)]
    revision: Option<u64>,
}

#[derive(Debug, Subcommand)]
pub enum Sources {
    #[command(flatten)]
    Write(super::PlanCommand),
    Find(SourceFind),
    Get {
        #[arg(long, alias = "shop")]
        shop_id: String,
        #[arg(
            long,
            conflicts_with = "goods_id",
            required_unless_present = "goods_id"
        )]
        source_id: Option<String>,
        #[arg(long)]
        goods_id: Option<String>,
        #[arg(long)]
        include_deleted: bool,
    },
}

#[derive(Debug, Subcommand)]
pub enum Activity {
    List {
        #[arg(long, alias = "shop")]
        shop_id: String,
        #[arg(long)]
        from: Option<String>,
        #[arg(long)]
        to: Option<String>,
        #[arg(long)]
        actor: Option<String>,
        #[arg(long)]
        kind: Option<String>,
        #[arg(long, default_value_t = 0)]
        page: u32,
        #[arg(long,default_value_t=30,value_parser=clap::value_parser!(u32).range(1..=100))]
        page_size: u32,
    },
}

#[derive(Debug, Subcommand)]
pub enum Inventory {
    Check {
        #[arg(
            long,
            alias = "shop",
            conflicts_with = "job_id",
            required_unless_present = "job_id"
        )]
        shop_id: Option<String>,
        #[arg(long,conflicts_with="job_id",value_parser=operation_id)]
        operation_id: Option<String>,
        #[arg(long)]
        job_id: Option<String>,
        #[arg(long, conflicts_with = "job_id")]
        product_id: Option<String>,
        #[arg(long,conflicts_with="job_id",value_parser=clap::value_parser!(u32).range(0..=100000000))]
        threshold: Option<u32>,
        #[arg(long,conflicts_with="job_id",value_parser=["out","low","unknown"])]
        status: Option<String>,
        #[arg(long,value_parser=clap::value_parser!(u32).range(1..=100))]
        limit: Option<u32>,
        #[arg(long)]
        offset: Option<u64>,
    },
}

// 可选参数省略后沿用工作台默认值，不能把 null 或空标识发给旧桌面。
fn present(mut value: Value) -> Value {
    value
        .as_object_mut()
        .unwrap()
        .retain(|_, item| !item.is_null());
    value
}

pub fn checked(method: &str, params: Value) -> Result<Request, AgentError> {
    let invalid = |message| AgentError::new("INVALID_ARGUMENT", message);
    if matches!(method, "configs.find" | "sources.find") {
        if params["offset"].as_u64().unwrap_or(0) > 0 && params.get("revision").is_none() {
            return Err(invalid("翻页必须提供 revision"));
        }
        if let Some(query) = params.get("query") {
            if !query
                .as_str()
                .is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= 200)
            {
                return Err(invalid("query 须为 1 至 200 个字符"));
            }
        }
    }
    if method == "sources.get"
        && (params.get("goodsId").is_some() == params.get("sourceId").is_some())
    {
        return Err(invalid("goodsId 和 sourceId 须提供一个"));
    }
    if method == "sources.find"
        && params["minPrice"]
            .as_f64()
            .zip(params["maxPrice"].as_f64())
            .is_some_and(|(min, max)| min > max)
    {
        return Err(invalid("最低价不能高于最高价"));
    }
    if method == "inventory.check" {
        if params.get("jobId").is_some() {
            if params.as_object().is_none_or(|v| {
                v.keys()
                    .any(|k| !matches!(k.as_str(), "jobId" | "offset" | "limit"))
            }) {
                return Err(invalid("读取已有库存快照时仅可提供 jobId、offset 和 limit"));
            }
        } else if params["shopId"].as_str().is_none() || params["operationId"].as_str().is_none() {
            return Err(invalid("新库存检查须提供 shopId 和 operationId"));
        }
    }
    Ok(request(method, params))
}

impl Sources {
    pub fn request(&self) -> Result<Request, AgentError> {
        match self {
            Self::Write(command) => command.request("sources.preview", "sources.apply"),
            Self::Find(a) => {
                if [a.min_price, a.max_price]
                    .into_iter()
                    .flatten()
                    .any(|price| !price.is_finite() || price < 0.0)
                {
                    return Err(AgentError::new("INVALID_ARGUMENT", "核算价须是非负有限数"));
                }
                checked(
                    "sources.find",
                    present(json!({"shopId":a.shop_id,"query":a.query,
                    "category":a.category,"stockStatus":a.stock_status,"minPrice":a.min_price,"maxPrice":a.max_price,
                    "filter":a.filter,"includeDeleted":a.include_deleted,"limit":a.limit,"offset":a.offset,"revision":a.revision})),
                )
            }
            Self::Get {
                shop_id,
                source_id,
                goods_id,
                include_deleted,
            } => checked(
                "sources.get",
                present(json!({
                "shopId":shop_id,"sourceId":source_id,"goodsId":goods_id,"includeDeleted":include_deleted})),
            ),
        }
    }
}
impl Activity {
    pub fn request(&self) -> Result<Request, AgentError> {
        let Self::List {
            shop_id,
            from,
            to,
            actor,
            kind,
            page,
            page_size,
        } = self;
        checked(
            "activity.list",
            present(
                json!({"shopId":shop_id,"from":from,"to":to,"actor":actor,"kind":kind,"page":page,"pageSize":page_size}),
            ),
        )
    }
}
impl Inventory {
    pub fn request(&self) -> Result<Request, AgentError> {
        let Self::Check {
            shop_id,
            operation_id,
            job_id,
            product_id,
            threshold,
            status,
            limit,
            offset,
        } = self;
        let operation = shop_id.as_ref().map(|_| {
            operation_id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
        });
        checked(
            "inventory.check",
            present(
                json!({"shopId":shop_id,"jobId":job_id,"operationId":operation,
            "productId":product_id,"threshold":threshold,"status":status,"limit":limit,"offset":offset}),
            ),
        )
    }
}
