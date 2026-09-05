module Example.Shop.Analytics.Revenue

/// Total revenue across a set of order amounts.
let total (amounts: decimal seq) = Seq.sum amounts
