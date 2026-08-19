# Semantic-model coverage: fastcover

Generated: 2026-08-19T05:50:19.795Z. Datasets: fastcover_marts, fastcover_reporting.

This report is advisory. Curated metrics stay accurate; the guarded
text-to-SQL fallback can already reach the columns below. Promote the ones
worth a first-class, reconciled metric or dimension into the model.

## Modelled tables — columns not yet curated

### fastcover_marts.ga4_events_daily (source: ga4_transactions)
- client
- source_medium

### fastcover_marts.ga4_sessions_daily (source: ga4_sessions)
- client
- source_medium

### fastcover_marts.gads_campaign_daily (source: google)
- client
- campaign_id
- campaign_name
- impressions
- clicks
- purchase
- named_revenue

### fastcover_marts.gads_impression_share (source: google_impression_share)
- client
- customer_id
- campaign_id
- campaign_name
- search_top_impression_share
- search_absolute_top_impression_share
- search_click_share
- content_impression_share
- clicks
- eligible_search_impressions

### fastcover_marts.meta_campaign_daily (source: meta)
- client
- country
- campaign_id
- group_name
- stream
- campaign_type
- impressions
- clicks
- landing_page_views
- revenue

### fastcover_marts.tiktok_campaign_daily (source: tiktok)
- client
- campaign_id
- impressions
- clicks
- conversion_value

### fastcover_reporting.rollup_age_daily (source: age)
- client
- currency
- impressions
- clicks
- primary_cpa
- roas

### fastcover_reporting.rollup_platform_daily (source: blended)
- client
- currency
- impressions
- clicks
- primary_cpa
- roas

## Allowed tables not modelled by any source
- fastcover_marts.age_gender_daily
- fastcover_marts.component_performance
- fastcover_marts.component_variant_performance
- fastcover_marts.creative_age_reporting
- fastcover_marts.creative_reporting
- fastcover_marts.ga4_landing_page_daily
- fastcover_marts.ga4_landing_page_variant_daily
- fastcover_marts.gads_keyword_impression_share
- fastcover_marts.gads_keyword_quality
- fastcover_marts.gads_keywords_daily
- fastcover_marts.gads_search_terms_daily
- fastcover_marts.tiktok_creative_reporting
- fastcover_reporting.gads_impression_share_account
- fastcover_reporting.pacing_targets
- fastcover_reporting.rollup_conversions_daily
- fastcover_reporting.rollup_daily
