import { AnyApi, FixedPointNumber, forceToCurrencyName, Token } from '@acala-network/sdk-core';
import { Wallet } from '@acala-network/sdk';
import { StableAssetRx, PoolInfo, SwapInResult, SwapOutResult } from '@acala-network/sdk-stable-asset';
import { NutsDexOnlySupportApiRx } from './errors';
import { Observable, combineLatest, BehaviorSubject } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import {
  AmountTooSmall, NoTradingPathError, ParamsNotAcceptableForDexProvider,
} from '@acala-network/sdk-swap';
import {
  BaseSwap,
  DexSource,
  OverwriteCallParams,
  SwapParamsWithExactPath,
  SwapResult,
  TradingPair,
  TradingPath

} from '@acala-network/sdk-swap/dist/cjs/types'
import { ObsInnerType, SubmittableExtrinsic } from '@polkadot/api/types';

export interface NutsDexConfigs {
  api: AnyApi;
  wallet: Wallet;
  stableAssets?: StableAssetRx;
}

export class NutsDex implements BaseSwap {
  private api: AnyApi;
  private wallet: Wallet;
  private stableAsset: StableAssetRx;
  private availablePools$: BehaviorSubject<PoolInfo[]>;
  private liquidToken: Token;
  private exchangeRate!: FixedPointNumber;
  public readonly tradingPairs$: Observable<TradingPair[]>;

  constructor({ api, wallet, stableAssets }: NutsDexConfigs) {
    this.api = api;
    this.wallet = wallet;

    if (api.type === 'promise') {
      throw new NutsDexOnlySupportApiRx();
    }

    this.stableAsset = stableAssets ?? new StableAssetRx(this.api as unknown as any, this.wallet);
    this.tradingPairs$ = this.initTradingPairs$();
    this.availablePools$ = new BehaviorSubject<PoolInfo[]>([]);
    this.liquidToken = wallet.getPresetTokens().liquidToken;

    this.updateExchangeRate();
  }

  private updateExchangeRate() {
    this.exchangeRate$.subscribe((exchangeRate) => {
      this.exchangeRate = exchangeRate;
    });
  }

  get exchangeRate$(): Observable<FixedPointNumber> {
    return this.wallet.homa.env$.pipe(map((env) => env.exchangeRate))
  }

  private initTradingPairs$() {
    return this.stableAsset.subscribeAllPools().pipe(
      map((data) => {
        this.availablePools$.next(data);
        const tradingPairs: TradingPair[] = [];

        data.forEach((item) => {
          const assets = item.assets;

          for (let i = 0; i < assets.length; i++) {
            for (let j = i + 1; j < assets.length; j++) {
              tradingPairs.push([
                this.wallet.getToken(assets[i]),
                this.wallet.getToken(assets[j])
              ] as TradingPair);
            }
          }
        });

        return tradingPairs;
      })
    );
  }

  public get source(): DexSource {
    return 'nuts';
  }

  public filterPath(path: TradingPath): boolean {
    return path[1].length === 2;
  }

  private getPoolInfo(data: PoolInfo[], token0: Token, token1: Token) {
    const pool = data.find((item) => {
      const assets = item.assets.map((i) => forceToCurrencyName(i));

      return assets.indexOf(token0.name) !== -1 && assets.indexOf(token1.name) !== -1;
    });

    if (!pool) throw new NoTradingPathError();

    const assets = pool.assets.map((i) => forceToCurrencyName(i));
    const token0Index = assets.indexOf(token0.name);
    const token1Index = assets.indexOf(token1.name);
    const balance0 = FixedPointNumber._fromBN(pool.balances[token0Index], token0.decimal);
    const balance1 = FixedPointNumber._fromBN(pool.balances[token1Index], token1.decimal);

    return {
      poolId: Number(pool.poolAsset.asStableAssetPoolToken.toString()),
      token0Index: assets.indexOf(token0.name),
      token1Index: assets.indexOf(token1.name),
      token0Amount: pool.balances[assets.indexOf(token0.name)],
      token1Amount: pool.balances[assets.indexOf(token0.name)],
      balance0,
      balance1,
    };
  }

  private subscribePoolInfo(token0: Token, token1: Token) {
    return this.availablePools$.pipe(map((pool) => this.getPoolInfo(pool, token0, token1)));
  }

  private mapStableSwapResultToSwapResult(
    ratio: FixedPointNumber,
    pool: ObsInnerType<ReturnType<typeof NutsDex.prototype.subscribePoolInfo>>,
    params: SwapParamsWithExactPath,
    result: SwapInResult | SwapOutResult
  ): SwapResult {
    const { mode } = params;

    if (
      result.inputToken.symbol === 'AUSD' ||
      result.inputToken.symbol === 'KUSD' ||
      result.inputToken.symbol === 'USDT' ||
      result.inputToken.symbol === 'USDCet' ||
      result.outputToken.symbol === 'AUSD' ||
      result.outputToken.symbol === 'KUSD' ||
      result.outputToken.symbol === 'USDT' ||
      result.outputToken.symbol === 'USDCet'
    ) {
      if (Number(result.inputAmount.toNumber()) <= 0.001) throw new AmountTooSmall();
      if (Number(result.outputAmount.toNumber()) <= 0.001) throw new AmountTooSmall();
    }

    const estimatedOutputAmount = ratio.mul(result.inputAmount);
    const priceImpact = estimatedOutputAmount.minus(result.outputAmount).div(estimatedOutputAmount).abs();
    const exchangeFeeRate = result.feeAmount.div(result.outputAmount);

    return {
      source: this.source,
      mode,
      path: [[this.source, params.path]] as [DexSource, Token[]][],
      input: {
        token: result.inputToken,
        amount: result.inputAmount
      },
      output: {
        token: result.outputToken,
        amount: result.outputAmount
      },
      // no midPrice in nuts pool
      midPrice: FixedPointNumber.ZERO,
      priceImpact: priceImpact,
      naturalPriceImpact: priceImpact.sub(exchangeFeeRate).max(FixedPointNumber.ZERO),
      exchangeFee: result.feeAmount,
      exchangeFeeRate, 
      acceptiveSlippage: params.acceptiveSlippage,
      callParams: result.toChainData()
    };
  }

  public swap(params: SwapParamsWithExactPath): Observable<SwapResult> {
    const { input, path, mode, acceptiveSlippage } = params;
    const [token0, token1] = path;

    return combineLatest({
      homaEnv: this.wallet.homa.env$,
      pool: this.subscribePoolInfo(token0, token1)
    }).pipe(
      switchMap(({ homaEnv, pool }) => {
        const exchangeRate = homaEnv.exchangeRate;
        const { poolId, token0Index, token1Index } = pool;

        if (mode === 'EXACT_OUTPUT') {
          return combineLatest({
            result: this.stableAsset.getSwapInAmount(poolId, token0Index, token1Index, input, acceptiveSlippage || 0, exchangeRate),
            estimated: this.stableAsset.getSwapInAmount(poolId, token0Index, token1Index, new FixedPointNumber(1, input.getPrecision()), 0, exchangeRate)
          }).pipe(map(({ result, estimated }) => {
            const ratio = estimated.outputAmount.div(estimated.inputAmount);
            return this.mapStableSwapResultToSwapResult(ratio, pool, params, result)
          }));
        }

        return combineLatest({
          result: this.stableAsset.getSwapOutAmount(poolId, token0Index, token1Index, input, acceptiveSlippage || 0, exchangeRate),
          estimated: this.stableAsset.getSwapOutAmount(poolId, token0Index, token1Index, new FixedPointNumber(1, input.getPrecision()), 0, exchangeRate)
        }).pipe(map(({ result, estimated }) => {
          const ratio = estimated.outputAmount.div(estimated.inputAmount);
          return this.mapStableSwapResultToSwapResult(ratio, pool, params, result)
        }));
      })
    );
  }

  public getAggregateTradingPath(result: SwapResult) {
    return { Taiga: [result.callParams?.[0], result.callParams?.[1], result.callParams?.[2]] };
  }

  public getTradingTx(
    result: SwapResult,
    overwrite?: OverwriteCallParams
  ): SubmittableExtrinsic<'promise'> | SubmittableExtrinsic<'rxjs'> {
    const { path } = result;
    const [source] = path[0];

    if (source !== this.source) throw new ParamsNotAcceptableForDexProvider(this.source);
    // never failed, just to avoid type check error
    if (!result.callParams) throw new Error(`can't find call params in result`);

    const params = result.callParams;

    if (overwrite?.input) {
      const { liquidToken } = this.wallet.getPresetTokens();
      params[3] = result.input.token.isEqual(liquidToken)
        ? overwrite.input.mul(this.exchangeRate).toChainData()
        : overwrite.input.toChainData();
    }

    if (overwrite?.output) {
      const { liquidToken } = this.wallet.getPresetTokens();
      params[4] = result.output.token.isEqual(liquidToken)
        ? overwrite.output.mul(this.exchangeRate).toChainData()
        : overwrite.output.toChainData();
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.api.tx.stableAsset.swap(...(params as [any, any, any, any, any, any]));
  }
}
